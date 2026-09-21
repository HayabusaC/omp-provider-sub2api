import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";

export type RoutedApi = "openai-responses" | "openai-completions" | "anthropic-messages";

export interface KeyRecord {
  id: number;
  key: string;
}

export interface KeyDiscovery {
  credentialId: number;
  status: "ok" | "invalid-key" | "endpoint-error";
  httpStatus?: number;
  modelIds: string[];
  rejectedModelIds?: string[];
  routedModels?: Record<string, string>;
  detail?: string;
}

export interface PoolSnapshot {
  models: ProviderModelConfig[];
  routes: Map<string, number[]>;
  discoveries: KeyDiscovery[];
}

export function poolFromDiscoveries(discoveries: KeyDiscovery[]): PoolSnapshot {
  const routes = new Map<string, number[]>();
  for (const discovery of discoveries) {
    if (discovery.status !== "ok") continue;
    for (const modelId of discovery.modelIds) {
      const ids = routes.get(modelId) ?? [];
      ids.push(discovery.credentialId);
      routes.set(modelId, ids);
    }
  }
  return { models: [...routes.keys()].sort().map(modelConfig), routes, discoveries };
}

export function normalizeBaseURL(value: string): { apiBase: string; anthropicBase: string } {
  const url = new URL(value.trim());
  if (!/^https?:$/u.test(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("baseURL must be an http(s) URL without credentials, query, or fragment");
  }
  const pathname = url.pathname.replace(/\/+$/u, "");
  const hasV1 = pathname.endsWith("/v1");
  const root = new URL(url);
  root.pathname = hasV1 ? pathname : `${pathname}/v1`;
  const anthropic = new URL(root);
  anthropic.pathname = anthropic.pathname.replace(/\/v1$/u, "");
  return {
    apiBase: root.toString().replace(/\/$/u, ""),
    anthropicBase: anthropic.toString().replace(/\/$/u, ""),
  };
}

export function routeApi(id: string, configured: string): RoutedApi {
  if (configured !== "auto") return configured as RoutedApi;
  if (/claude/iu.test(id)) return "anthropic-messages";
  if (/(?:^|\/)(?:gpt|codex|chatgpt|o\d)(?:-|$)/iu.test(id)) return "openai-responses";
  return "openai-completions";
}

function modelConfig(id: string): ProviderModelConfig {
  return {
    id,
    name: id,
    api: "sub2api-key-router",
    reasoning: /(claude|codex|gpt-[56])/iu.test(id),
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 32_768,
  };
}

const PROBE_TIMEOUT_MS = 30_000;
const PROBE_CONCURRENCY = 4;

interface ProbeOptions {
  configuredApi?: string;
  anthropicBase?: string;
}

interface ProbeResult { accepted: boolean; routedTo?: string; }

function responseModel(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const model = (value as { model?: unknown }).model;
  return typeof model === "string" && model ? model : undefined;
}

async function probeModel(
  modelId: string,
  key: string,
  apiBase: string,
  fetchImpl: typeof fetch,
  options: ProbeOptions,
): Promise<ProbeResult> {
  const api = routeApi(modelId, options.configuredApi ?? "auto");
  const anthropicBase = options.anthropicBase ?? apiBase.replace(/\/v1$/u, "");
  const url = api === "anthropic-messages"
    ? `${anthropicBase}/v1/messages`
    : api === "openai-responses" ? `${apiBase}/responses` : `${apiBase}/chat/completions`;
  const body = api === "anthropic-messages"
    ? { model: modelId, max_tokens: 16, stream: false, messages: [{ role: "user", content: "Reply OK" }] }
    : api === "openai-responses"
      ? { model: modelId, max_output_tokens: 16, stream: false, input: "Reply OK" }
      : { model: modelId, max_tokens: 16, stream: false, messages: [{ role: "user", content: "Reply OK" }] };
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(api === "anthropic-messages" ? { "anthropic-version": "2023-06-01", "x-api-key": key } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      redirect: "error",
    });
    if (!response.ok) return { accepted: false };
    const servedModel = responseModel(await response.json());
    return servedModel === modelId
      ? { accepted: true }
      : { accepted: false, ...(servedModel ? { routedTo: servedModel } : {}) };
  } catch {
    return { accepted: false };
  }
}

async function verifyModels(
  modelIds: string[],
  key: string,
  apiBase: string,
  fetchImpl: typeof fetch,
  options: ProbeOptions,
): Promise<{ accepted: string[]; rejected: string[]; routed: Record<string, string> }> {
  const accepted: string[] = [];
  const rejected: string[] = [];
  const routed: Record<string, string> = {};
  for (let offset = 0; offset < modelIds.length; offset += PROBE_CONCURRENCY) {
    const batch = modelIds.slice(offset, offset + PROBE_CONCURRENCY);
    const results = await Promise.all(batch.map(modelId => probeModel(modelId, key, apiBase, fetchImpl, options)));
    for (let index = 0; index < batch.length; index++) {
      const modelId = batch[index]!;
      const result = results[index]!;
      if (result.accepted) accepted.push(modelId);
      else {
        rejected.push(modelId);
        if (result.routedTo) routed[modelId] = result.routedTo;
      }
    }
  }
  return { accepted, rejected, routed };
}

export async function discoverPool(
  keys: readonly KeyRecord[],
  apiBase: string,
  fetchImpl: typeof fetch = fetch,
  options: ProbeOptions = {},
): Promise<PoolSnapshot> {
  const discoveries = await Promise.all(keys.map(async ({ id, key }): Promise<KeyDiscovery> => {
    try {
      const response = await fetchImpl(`${apiBase}/models`, {
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });
      if (response.status === 401 || response.status === 403) {
        return { credentialId: id, status: "invalid-key", httpStatus: response.status, modelIds: [] };
      }
      if (!response.ok) {
        return { credentialId: id, status: "endpoint-error", httpStatus: response.status, modelIds: [] };
      }
      const json = await response.json() as { data?: unknown };
      if (!Array.isArray(json.data)) {
        return { credentialId: id, status: "endpoint-error", httpStatus: response.status, modelIds: [], detail: "missing data array" };
      }
      const advertisedModelIds = [...new Set(json.data.map(item => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string") return (item as { id: string }).id;
        return "";
      }).filter(Boolean))];
      const verified = await verifyModels(advertisedModelIds, key, apiBase, fetchImpl, options);
      return {
        credentialId: id,
        status: "ok",
        httpStatus: response.status,
        modelIds: verified.accepted,
        rejectedModelIds: verified.rejected,
        ...(Object.keys(verified.routed).length ? { routedModels: verified.routed } : {}),
      };
    } catch (error) {
      return { credentialId: id, status: "endpoint-error", modelIds: [], detail: error instanceof Error ? error.message : String(error) };
    }
  }));

  return poolFromDiscoveries(discoveries);
}
