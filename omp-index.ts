import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { ExtensionAPI, ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";
import {
  type Api,
  type AssistantMessageEvent,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { resolveModelPolicy } from "@oh-my-pi/pi-catalog/compat/resolve";
import { discoverPool, normalizeBaseURL, poolFromDiscoveries, routeApi, type KeyDiscovery, type KeyRecord } from "./omp-pool.ts";
import {
  fetchEffectiveBillingMultiplier,
  fetchPricingSnapshot,
  modelPricingStat,
  providerModelCost,
  type ModelStat,
  type PricingSnapshot,
} from "./pricing.ts";

const PLUGIN = "omp-provider-sub2api";
const ROUTER_API = "sub2api-key-router";
const UNKNOWN_COST: ProviderModelConfig["cost"] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".omp", "agent");
const cachePath = join(agentDir, "sub2api-model-cache.json");

interface CacheFile {
  provider: string;
  baseURL: string;
  modelIds: string[];
  verifiedModelsByCredential?: Record<string, { keyHash: string; modelIds: string[] }>;
}
let liveAuthStorage: any;
let providerId = "sub2api";
let apiSetting = "auto";
let apiBase = "";
let anthropicBase = "";
let routes = new Map<string, number[]>();
let costsByCredential = new Map<number, Map<string, ProviderModelConfig["cost"]>>();
let verifiedModelsByCredential = new Map<number, string[]>();
let verifiedKeyHashesByCredential = new Map<number, string>();
let pricingSnapshotsByCredential = new Map<number, PricingSnapshot>();
let pricingStatsByCredential = new Map<number, Map<string, Pick<ModelStat, "cost" | "accountCost">>>();
let billingMultipliersByCredential = new Map<number, number>();
let discoveries: KeyDiscovery[] = [];
let publishedFingerprint = "";
let pendingRefresh: Promise<PoolSnapshot> | undefined;

function storedKeys(): KeyRecord[] {
  if (!liveAuthStorage) return [];
  return liveAuthStorage.listStoredCredentials(providerId)
    .filter((row: any) => row.credential?.type === "api_key" && typeof row.credential.key === "string")
    .map((row: any) => ({ id: row.id, key: row.credential.key }));
}

function keyHash(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function cloneModel(model: Model<Api>, api: Api): Model<Api> {
  const baseUrl = api === "anthropic-messages" ? anthropicBase : apiBase;
  const candidate = { ...model, api, baseUrl, compat: undefined } as Model<Api>;
  const policy = resolveModelPolicy(candidate);
  return { ...candidate, compat: policy.compat, identity: policy.identity, thinking: policy.thinking } as Model<Api>;
}

function dispatch(model: Model<Api>, context: Context, options: SimpleStreamOptions | undefined, key: string) {
  const api = routeApi(model.id, apiSetting);
  const next = { ...options, apiKey: key };
  if (api === "anthropic-messages") return streamAnthropic(cloneModel(model, api) as Model<"anthropic-messages">, context, next);
  if (api === "openai-responses") return streamOpenAIResponses(cloneModel(model, api) as Model<"openai-responses">, context, next);
  return streamOpenAICompletions(cloneModel(model, api) as Model<"openai-completions">, context, next);
}

export function isAuthOrPermissionFailure(error: unknown): boolean {
  const structuredStatus = typeof error === "object" && error && "errorStatus" in error
    ? (error as { errorStatus?: unknown }).errorStatus : undefined;
  const status = typeof structuredStatus === "number" ? structuredStatus : AIError.status(error);
  const message = error instanceof Error ? error.message : typeof error === "object" && error && "errorMessage" in error
    ? String((error as { errorMessage?: unknown }).errorMessage ?? "") : String(error);
  if (status === 401 || status === 403 || status === 404) return true;
  return /unauthorized|forbidden|permission|model.*(?:access|not found|not available|unsupported)/iu.test(message);
}

export function costForCredential(
  costs: Map<number, Map<string, ProviderModelConfig["cost"]>>,
  credentialId: number,
  modelId: string,
): ProviderModelConfig["cost"] {
  return costs.get(credentialId)?.get(modelId) ?? UNKNOWN_COST;
}

function routedStream(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
  const outer = new AssistantMessageEventStream();
  // Freeze routing inputs for this response. A background refresh replaces the
  // maps atomically, but must not change the price or credential halfway through
  // an already-running failover chain.
  const requestRoutes = routes;
  const requestCosts = costsByCredential;
  const requestKeys = new Map(storedKeys().map(({ id, key }) => [id, key]));
  void (async () => {
    const candidateIds = requestRoutes.get(model.id) ?? [];
    if (candidateIds.length === 0) {
      outer.fail(new Error(`No stored sub2api credential can access model ${model.id}`));
      return;
    }
    for (const credentialId of candidateIds) {
      const key = requestKeys.get(credentialId);
      if (!key) continue;
      // Never inherit the picker price, which belongs to the first eligible key.
      // Unknown pricing is safer as zero than charging this key at another key's rate.
      const routedCost = costForCredential(requestCosts, credentialId, model.id);
      const routedModel = { ...model, cost: routedCost };
      const held: AssistantMessageEvent[] = [];
      let committed = false;
      try {
        for await (const event of dispatch(routedModel, context, options, key)) {
          if (!committed) {
            held.push(event);
            if (["text_delta", "thinking_delta", "toolcall_delta", "done"].includes(event.type)) {
              committed = true;
              for (const buffered of held) outer.push(buffered);
            } else if (event.type === "error") {
              if (isAuthOrPermissionFailure(event.error)) break;
              for (const buffered of held) outer.push(buffered);
              return;
            }
          } else outer.push(event);
        }
        if (outer.done) return;
        if (committed) {
          outer.fail(new Error("sub2api stream ended without a terminal event"));
          return;
        }
      } catch (error) {
        if (!isAuthOrPermissionFailure(error)) {
          outer.fail(error);
          return;
        }
      }
    }
    outer.fail(new Error(`Every credential mapped to ${model.id} was rejected (401/403 or model permission)`));
  })();
  return outer;
}

async function readCachedModels(): Promise<ProviderModelConfig[]> {
  try {
    const cached = JSON.parse(await readFile(cachePath, "utf8")) as CacheFile;
    if (cached.provider !== providerId || cached.baseURL !== apiBase || !Array.isArray(cached.modelIds)) return [];
    const verifiedEntries = Object.entries(cached.verifiedModelsByCredential ?? {}).flatMap(([id, entry]) => {
      const credentialId = Number(id);
      return Number.isInteger(credentialId) && entry && typeof entry.keyHash === "string"
        && Array.isArray(entry.modelIds) && entry.modelIds.every(model => typeof model === "string")
        ? [[credentialId, entry] as const]
        : [];
    });
    verifiedModelsByCredential = new Map(verifiedEntries.map(([id, entry]) => [id, [...new Set(entry.modelIds)]]));
    verifiedKeyHashesByCredential = new Map(verifiedEntries.map(([id, entry]) => [id, entry.keyHash]));
    return cached.modelIds.map(id => ({
      id, name: id, api: ROUTER_API, reasoning: /(claude|codex|gpt-[56])/iu.test(id), input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 32_768,
    }));
  } catch { return []; }
}

async function writeCachedModels(modelIds: string[]): Promise<void> {
  await mkdir(agentDir, { recursive: true });
  const temporary = `${cachePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({
    provider: providerId,
    baseURL: apiBase,
    modelIds,
    verifiedModelsByCredential: Object.fromEntries([...verifiedModelsByCredential].map(([id, modelIds]) => [id, {
      keyHash: verifiedKeyHashesByCredential.get(id),
      modelIds,
    }])),
  }, null, 2), {
    encoding: "utf8",
    flag: "wx",
  });
  try {
    await rename(temporary, cachePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM" && (error as NodeJS.ErrnoException).code !== "EEXIST") {
      await unlink(temporary).catch(() => {});
      throw error;
    }
    await unlink(cachePath).catch((unlinkError: NodeJS.ErrnoException) => {
      if (unlinkError.code !== "ENOENT") throw unlinkError;
    });
    await rename(temporary, cachePath);
  }
}

type PoolSnapshot = Awaited<ReturnType<typeof discoverPool>>;

function providerFingerprint(
  snapshot: PoolSnapshot,
  costs: Map<number, Map<string, ProviderModelConfig["cost"]>>,
): string {
  return JSON.stringify({
    routes: [...snapshot.routes].map(([model, ids]) => [model, ids]),
    costs: [...costs].map(([credentialId, models]) => [
      credentialId,
      [...models].map(([model, cost]) => [model, cost]),
    ]),
  });
}

export default async function sub2apiOMP(pi: ExtensionAPI): Promise<void> {
  const settings: Record<string, unknown> = await getPluginSettings(PLUGIN, process.cwd()).catch(() => ({}));
  providerId = typeof settings.providerId === "string" && settings.providerId.trim() ? settings.providerId.trim() : "sub2api";
  apiSetting = typeof settings.api === "string" ? settings.api : "auto";
  const configuredBaseURL = typeof settings.baseURL === "string" && settings.baseURL.trim()
    ? settings.baseURL.trim()
    : process.env.SUB2API_BASE_URL?.trim();
  if (!configuredBaseURL) {
    pi.logger.warn("sub2api plugin inactive: configure baseURL with `omp plugin config set omp-provider-sub2api baseURL <url>`");
    return;
  }
  ({ apiBase, anthropicBase } = normalizeBaseURL(configuredBaseURL));
  const cachedModels = await readCachedModels();
  pi.registerProvider(providerId, {
    baseUrl: apiBase,
    api: ROUTER_API,
    streamSimple: routedStream,
    // OMP 18 requires extension-owned apiKey/oauth whenever a static `models`
    // array is supplied. Dynamic discovery is the credential-neutral seam and
    // keeps all actual keys exclusively in AuthStorage.
    fetchDynamicModels: async () => cachedModels,
  });

  const performRefresh = async (ctx: any, forceVerify = false): Promise<PoolSnapshot> => {
    liveAuthStorage = ctx.modelRegistry.authStorage;
    const keys = storedKeys();
    const activeCredentialIds = new Set(keys.map(({ id }) => id));
    for (const credentialId of verifiedModelsByCredential.keys()) {
      if (!activeCredentialIds.has(credentialId)) {
        verifiedModelsByCredential.delete(credentialId);
        verifiedKeyHashesByCredential.delete(credentialId);
      }
    }
    const keysToVerify = forceVerify ? keys : keys.filter(({ id, key }) =>
      !verifiedModelsByCredential.has(id) || verifiedKeyHashesByCredential.get(id) !== keyHash(key));
    const verified = await discoverPool(keysToVerify, apiBase, fetch, { configuredApi: apiSetting, anthropicBase });
    const pricing = await Promise.all(keys.map(async ({ id, key }) => {
        const [usage, billingMultiplier] = await Promise.all([
          fetchPricingSnapshot(apiBase, key),
          fetchEffectiveBillingMultiplier(apiBase, key),
        ]);
        return { id, usage, billingMultiplier };
      }));
    for (const discovery of verified.discoveries) {
      if (discovery.status === "ok") {
        verifiedModelsByCredential.set(discovery.credentialId, discovery.modelIds);
        const key = keys.find(candidate => candidate.id === discovery.credentialId)?.key;
        if (key) verifiedKeyHashesByCredential.set(discovery.credentialId, keyHash(key));
      } else {
        verifiedModelsByCredential.delete(discovery.credentialId);
        verifiedKeyHashesByCredential.delete(discovery.credentialId);
      }
    }
    const verifiedById = new Map(verified.discoveries.map(discovery => [discovery.credentialId, discovery]));
    const snapshot = poolFromDiscoveries(keys.map(({ id }) => verifiedById.get(id) ?? {
      credentialId: id,
      status: "ok",
      modelIds: verifiedModelsByCredential.get(id) ?? [],
      detail: "cached verified pool",
    }));
    routes = snapshot.routes;
    discoveries = snapshot.discoveries;
    for (const credentialId of pricingSnapshotsByCredential.keys()) {
      if (!activeCredentialIds.has(credentialId)) pricingSnapshotsByCredential.delete(credentialId);
    }
    for (const credentialId of pricingStatsByCredential.keys()) {
      if (!activeCredentialIds.has(credentialId)) pricingStatsByCredential.delete(credentialId);
    }
    for (const credentialId of billingMultipliersByCredential.keys()) {
      if (!activeCredentialIds.has(credentialId)) billingMultipliersByCredential.delete(credentialId);
    }

    const nextCostsByCredential = new Map<number, Map<string, ProviderModelConfig["cost"]>>();
    for (const { id, usage, billingMultiplier } of pricing) {
      const previousSnapshot = pricingSnapshotsByCredential.get(id);
      const effectiveStats = new Map(pricingStatsByCredential.get(id));
      if (usage) {
        for (const model of snapshot.models) {
          const stat = modelPricingStat(previousSnapshot, usage, model.id);
          if (stat) effectiveStats.set(model.id, stat);
        }
        pricingSnapshotsByCredential.set(id, usage);
        pricingStatsByCredential.set(id, effectiveStats);
      }
      if (billingMultiplier !== undefined) billingMultipliersByCredential.set(id, billingMultiplier);
      const effectiveBillingMultiplier = billingMultipliersByCredential.get(id);
      nextCostsByCredential.set(id, new Map(snapshot.models.flatMap(model => {
        const cost = providerModelCost(model.id, effectiveStats.get(model.id), effectiveBillingMultiplier);
        return cost ? [[model.id, cost] as const] : [];
      })));
    }
    const fingerprint = providerFingerprint(snapshot, nextCostsByCredential);
    const pricedModels = snapshot.models.map(model => {
      const credentialId = snapshot.routes.get(model.id)?.[0];
      const cost = credentialId === undefined ? undefined : nextCostsByCredential.get(credentialId)?.get(model.id);
      return cost ? { ...model, cost } : model;
    });
    costsByCredential = nextCostsByCredential;
    if (fingerprint !== publishedFingerprint) {
      ctx.modelRegistry.registerProvider(providerId, {
        baseUrl: apiBase,
        api: ROUTER_API,
        streamSimple: routedStream,
        fetchDynamicModels: async () => pricedModels,
      });
      publishedFingerprint = fingerprint;
      await ctx.modelRegistry.refreshRuntimeProviders("online");
    }
    const currentPrice = ctx.model?.provider === providerId
      ? pricedModels.find(model => model.id === ctx.model.id)?.cost
      : undefined;
    if (currentPrice && ctx.model) ctx.model.cost = currentPrice;
    await writeCachedModels([...routes.keys()]);
    return snapshot;
  };

  const refresh = (ctx: any, forceVerify = false): Promise<PoolSnapshot> => {
    if (pendingRefresh) return pendingRefresh;
    pendingRefresh = performRefresh(ctx, forceVerify).finally(() => { pendingRefresh = undefined; });
    return pendingRefresh;
  };

  pi.on("session_start", async (_event, ctx) => {
    await refresh(ctx);
  });

  pi.registerCommand("sub2api-key-add", {
    description: "Add a sub2api key to OMP AuthStorage",
    handler: async (_args, ctx) => {
      const key = await ctx.ui.input(`API key for ${providerId} (stored in OMP credentials)`);
      if (!key?.trim()) return;
      const normalizedKey = key.trim();
      await ctx.modelRegistry.authStorage.upsertCredential(providerId, { type: "api_key", key: normalizedKey, source: "login" });
      for (const credential of storedKeys()) {
        if (credential.key === normalizedKey) {
          verifiedModelsByCredential.delete(credential.id);
          verifiedKeyHashesByCredential.delete(credential.id);
        }
      }
      const snapshot = await refresh(ctx);
      const rejected = snapshot.discoveries.reduce((sum, item) => sum + (item.rejectedModelIds?.length ?? 0), 0);
      ctx.ui.notify(`Saved key; verified ${snapshot.models.length} models from ${snapshot.discoveries.filter(item => item.status === "ok").length} valid keys; rejected ${rejected}`, "info");
    },
  });

  pi.registerCommand("sub2api-test", {
    description: "Refresh and report each stored key's model-pool status",
    handler: async (_args, ctx) => {
      const snapshot = await refresh(ctx, true);
      const summary = snapshot.discoveries.map((item, index) => `Key ${index + 1}: ${item.status}${item.httpStatus ? ` HTTP ${item.httpStatus}` : ""}, ${item.modelIds.length} verified, ${item.rejectedModelIds?.length ?? 0} rejected`).join("; ");
      ctx.ui.notify(`${providerId}: ${snapshot.models.length} merged models — ${summary || "no stored keys"}`, snapshot.models.length ? "info" : "warning");
    },
  });
}
