import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
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
import { discoverPool, normalizeBaseURL, routeApi, type KeyDiscovery, type KeyRecord } from "./omp-pool.ts";

const PLUGIN = "omp-provider-sub2api";
const ROUTER_API = "sub2api-key-router";
const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".omp", "agent");
const cachePath = join(agentDir, "sub2api-model-cache.json");

interface CacheFile { provider: string; baseURL: string; modelIds: string[]; }
let liveAuthStorage: any;
let providerId = "sub2api";
let apiSetting = "auto";
let apiBase = "";
let anthropicBase = "";
let routes = new Map<string, number[]>();
let discoveries: KeyDiscovery[] = [];

function storedKeys(): KeyRecord[] {
  if (!liveAuthStorage) return [];
  return liveAuthStorage.listStoredCredentials(providerId)
    .filter((row: any) => row.credential?.type === "api_key" && typeof row.credential.key === "string")
    .map((row: any) => ({ id: row.id, key: row.credential.key }));
}

function keyForId(id: number): string | undefined {
  return storedKeys().find(row => row.id === id)?.key;
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

function routedStream(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
  const outer = new AssistantMessageEventStream();
  void (async () => {
    const candidateIds = routes.get(model.id) ?? [];
    if (candidateIds.length === 0) {
      outer.fail(new Error(`No stored sub2api credential can access model ${model.id}`));
      return;
    }
    for (const credentialId of candidateIds) {
      const key = keyForId(credentialId);
      if (!key) continue;
      const held: AssistantMessageEvent[] = [];
      let committed = false;
      try {
        for await (const event of dispatch(model, context, options, key)) {
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
    return cached.modelIds.map(id => ({
      id, name: id, api: ROUTER_API, reasoning: /(claude|codex|gpt-[56])/iu.test(id), input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 32_768,
    }));
  } catch { return []; }
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

  const refresh = async (ctx: any) => {
    liveAuthStorage = ctx.modelRegistry.authStorage;
    const snapshot = await discoverPool(storedKeys(), apiBase);
    routes = snapshot.routes;
    discoveries = snapshot.discoveries;
    if (snapshot.models.length > 0) {
      ctx.modelRegistry.registerProvider(providerId, {
        baseUrl: apiBase,
        api: ROUTER_API,
        streamSimple: routedStream,
        fetchDynamicModels: async () => snapshot.models,
      });
      await writeFile(cachePath, JSON.stringify({ provider: providerId, baseURL: apiBase, modelIds: [...routes.keys()] }, null, 2), "utf8");
    }
    return snapshot;
  };

  pi.on("session_start", async (_event, ctx) => { await refresh(ctx); });

  pi.registerCommand("sub2api-key-add", {
    description: "Add a sub2api key to OMP AuthStorage",
    handler: async (_args, ctx) => {
      const key = await ctx.ui.input(`API key for ${providerId} (stored in OMP credentials)`);
      if (!key?.trim()) return;
      await ctx.modelRegistry.authStorage.upsertCredential(providerId, { type: "api_key", key: key.trim(), source: "login" });
      const snapshot = await refresh(ctx);
      ctx.ui.notify(`Saved key; merged ${snapshot.models.length} models from ${snapshot.discoveries.filter(item => item.status === "ok").length} valid keys`, "info");
    },
  });

  pi.registerCommand("sub2api-test", {
    description: "Refresh and report each stored key's model-pool status",
    handler: async (_args, ctx) => {
      const snapshot = await refresh(ctx);
      const summary = snapshot.discoveries.map((item, index) => `Key ${index + 1}: ${item.status}${item.httpStatus ? ` HTTP ${item.httpStatus}` : ""}, ${item.modelIds.length} models`).join("; ");
      ctx.ui.notify(`${providerId}: ${snapshot.models.length} merged models — ${summary || "no stored keys"}`, snapshot.models.length ? "info" : "warning");
    },
  });
}
