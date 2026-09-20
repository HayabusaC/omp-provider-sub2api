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
  detail?: string;
}

export interface PoolSnapshot {
  models: ProviderModelConfig[];
  routes: Map<string, number[]>;
  discoveries: KeyDiscovery[];
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

export async function discoverPool(
  keys: readonly KeyRecord[],
  apiBase: string,
  fetchImpl: typeof fetch = fetch,
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
      const modelIds = [...new Set(json.data.map(item => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string") return (item as { id: string }).id;
        return "";
      }).filter(Boolean))];
      return { credentialId: id, status: "ok", httpStatus: response.status, modelIds };
    } catch (error) {
      return { credentialId: id, status: "endpoint-error", modelIds: [], detail: error instanceof Error ? error.message : String(error) };
    }
  }));

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
