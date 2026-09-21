import type { ModelCost } from "@oh-my-pi/pi-ai";
import { getBundledModels, type GeneratedProvider } from "@oh-my-pi/pi-catalog/models";

export interface ModelStat {
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cost: number;
  actualCost: number;
  accountCost: number;
}

export interface PricingSnapshot { models: Map<string, ModelStat>; }

const PRICING_TIMEOUT_MS = 10_000;
const OFFICIAL_PROVIDERS: GeneratedProvider[] = ["openai", "openai-codex", "anthropic", "xai"];
export const CNY_TO_USD = 0.143;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function parsePricingSnapshot(value: unknown): PricingSnapshot | undefined {
  const root = record(value);
  if (!root || !Array.isArray(root.model_stats)) return undefined;
  const models = new Map<string, ModelStat>();
  for (const value of root.model_stats) {
    const item = record(value);
    if (!item || typeof item.model !== "string" || !item.model) continue;
    models.set(item.model, {
      model: item.model,
      requests: finite(item.requests),
      inputTokens: finite(item.input_tokens),
      outputTokens: finite(item.output_tokens),
      cacheReadTokens: finite(item.cache_read_tokens),
      cacheWriteTokens: finite(item.cache_creation_tokens ?? item.cache_write_tokens),
      totalTokens: finite(item.total_tokens),
      cost: finite(item.cost),
      actualCost: finite(item.actual_cost),
      accountCost: finite(item.account_cost),
    });
  }
  return { models };
}

export function upstreamAccountRateMultiplier(stat: Pick<ModelStat, "cost" | "accountCost">): number | undefined {
  if (!(stat.cost > 0) || !(stat.accountCost > 0)) return undefined;
  const multiplier = stat.accountCost / stat.cost;
  return Number.isFinite(multiplier) && multiplier > 0 ? multiplier : undefined;
}

export function accountCostReciprocal(stat: Pick<ModelStat, "cost" | "accountCost">): number | undefined {
  const accountMultiplier = upstreamAccountRateMultiplier(stat);
  return accountMultiplier === undefined ? undefined : 1 / accountMultiplier;
}

export function modelPricingStat(
  previous: PricingSnapshot | undefined,
  current: PricingSnapshot,
  modelId: string,
): Pick<ModelStat, "cost" | "accountCost"> | undefined {
  const currentStat = current.models.get(modelId);
  if (!currentStat) return undefined;

  const previousStat = previous?.models.get(modelId);
  if (!previousStat) return currentStat;

  const cost = currentStat.cost - previousStat.cost;
  const accountCost = currentStat.accountCost - previousStat.accountCost;
  return cost > 0 && accountCost > 0 ? { cost, accountCost } : undefined;
}

export function officialModelCost(modelId: string): ModelCost | undefined {
  for (const provider of OFFICIAL_PROVIDERS) {
    const model = getBundledModels(provider).find((candidate) => candidate.id === modelId);
    if (model) return model.cost;
  }
  return undefined;
}

export function providerModelCost(
  modelId: string,
  stat: Pick<ModelStat, "cost" | "accountCost"> | undefined,
  billingMultiplier: number | undefined,
): ModelCost | undefined {
  const official = officialModelCost(modelId);
  const reciprocal = stat && accountCostReciprocal(stat);
  if (!official || reciprocal === undefined || billingMultiplier === undefined) return undefined;
  const multiplier = reciprocal * billingMultiplier * CNY_TO_USD;
  const scale = <T extends ModelCost>(rates: T): T => ({
    ...rates,
    input: rates.input * multiplier,
    output: rates.output * multiplier,
    cacheRead: rates.cacheRead * multiplier,
    cacheWrite: rates.cacheWrite * multiplier,
  });
  return { ...scale(official), longContext: official.longContext ? scale(official.longContext) : undefined };
}

async function fetchJson(
  url: string,
  key: string,
  fetchImpl: typeof fetch,
): Promise<unknown | undefined> {
  try {
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(PRICING_TIMEOUT_MS),
      redirect: "error",
    });
    if (!response.ok) return undefined;
    return await response.json();
  } catch {
    return undefined;
  }
}

export async function fetchPricingSnapshot(
  apiBase: string,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PricingSnapshot | undefined> {
  return parsePricingSnapshot(await fetchJson(`${apiBase}/usage`, key, fetchImpl));
}

export async function fetchEffectiveBillingMultiplier(
  apiBase: string,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number | undefined> {
  const payload = record(await fetchJson(`${apiBase}/sub2api/billing`, key, fetchImpl));
  const multiplier = payload?.effective_rate_multiplier ?? payload?.effectiveRateMultiplier;
  return typeof multiplier === "number" && Number.isFinite(multiplier) && multiplier >= 0
    ? multiplier
    : undefined;
}
