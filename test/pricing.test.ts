import { describe, expect, test } from "bun:test";
import {
  CNY_TO_USD,
  modelPricingStat,
  officialModelCost,
  officialModelIdCandidates,
  providerModelCost,
  parsePricingSnapshot,
  upstreamAccountRateMultiplier,
} from "../pricing.ts";

const before = parsePricingSnapshot({ model_stats: [{
  model: "gpt-5.6-luna", requests: 96, input_tokens: 147751, output_tokens: 12804,
  cache_creation_tokens: 0, cache_read_tokens: 68096, total_tokens: 228651,
  cost: 0.5784615, actual_cost: 0.092954885, account_cost: 0.4627692,
}] })!;
const after = parsePricingSnapshot({ model_stats: [{
  model: "gpt-5.6-luna", requests: 97, input_tokens: 152143, output_tokens: 12810,
  cache_creation_tokens: 0, cache_read_tokens: 68096, total_tokens: 233049,
  cost: 0.5895315, actual_cost: 0.095058185, account_cost: 0.4716252,
}] })!;

describe("Sub2API response pricing", () => {
  test("derives the inverse account multiplier from model stats", () => {
    const earlier = before.models.get("gpt-5.6-luna")!;
    const later = after.models.get("gpt-5.6-luna")!;
    const delta = {
      cost: later.cost - earlier.cost,
      accountCost: later.accountCost - earlier.accountCost,
    };
    expect(upstreamAccountRateMultiplier(delta)).toBeCloseTo(0.8, 12);
  });

  test("detects a changed account multiplier from incremental model stats", () => {
    const previous = parsePricingSnapshot({ model_stats: [{
      model: "gpt-5.6-luna", cost: 10, account_cost: 8,
    }] })!;
    const current = parsePricingSnapshot({ model_stats: [{
      model: "gpt-5.6-luna", cost: 12, account_cost: 9,
    }] })!;
    const delta = modelPricingStat(previous, current, "gpt-5.6-luna")!;
    expect(delta).toEqual({ cost: 2, accountCost: 1 });
    expect(upstreamAccountRateMultiplier(delta)).toBe(0.5);
  });

  test("returns no new pricing stat when cumulative usage is unchanged", () => {
    expect(modelPricingStat(before, before, "gpt-5.6-luna")).toBeUndefined();
  });

  test("scales OMP official prices with a dynamic reciprocal", () => {
    const cost = providerModelCost(
      "gpt-5.6-luna",
      { cost: 0.012, accountCost: 0.009 },
      0.25,
    )!;
    expect(cost.input).toBeCloseTo(0.2 * (1 / 0.75) * 0.25 * CNY_TO_USD, 12);
    expect(cost.output).toBeCloseTo(1.2 * (1 / 0.75) * 0.25 * CNY_TO_USD, 12);
    expect(cost.cacheRead).toBeCloseTo(0.02 * (1 / 0.75) * 0.25 * CNY_TO_USD, 12);
    expect(cost.cacheWrite).toBeCloseTo(0.25 * (1 / 0.75) * 0.25 * CNY_TO_USD, 12);
  });

  test("keeps distinct prices for different keys serving the same model", () => {
    const first = providerModelCost("gpt-5.6-luna", { cost: 1, accountCost: 0.8 }, 0.15)!;
    const second = providerModelCost("gpt-5.6-luna", { cost: 1, accountCost: 0.5 }, 0.3)!;
    expect(first.input).toBeCloseTo(0.2 * (1 / 0.8) * 0.15 * CNY_TO_USD, 12);
    expect(second.input).toBeCloseTo(0.2 * (1 / 0.5) * 0.3 * CNY_TO_USD, 12);
    expect(first.input).not.toBe(second.input);
  });

  test("converts the billing amount from CNY to OMP USD", () => {
    const cost = providerModelCost("gpt-5.6-luna", { cost: 1, accountCost: 0.8 }, 0.15)!;
    expect(cost.input).toBeCloseTo(0.2 * 1.25 * 0.15 * 0.143, 12);
    expect(cost.output).toBeCloseTo(1.2 * 1.25 * 0.15 * 0.143, 12);
  });

  test("loads exact Gemini prices from the Google catalog", () => {
    expect(officialModelCost("gemini-2.5-flash")).toMatchObject({
      input: 0.3,
      output: 2.5,
      cacheRead: 0.03,
    });
    expect(officialModelCost("google/gemini-3.7-flash")).toMatchObject({
      input: 0.75,
      output: 3.75,
      cacheRead: 0.075,
    });
  });

  test("uses bounded Gemini aliases for sub2api routing variants", () => {
    expect(officialModelIdCandidates("gemini-3-flash")).toEqual([
      "gemini-3-flash",
      "gemini-3-flash-preview",
    ]);
    expect(officialModelCost("gemini-3-flash")).toEqual(
      officialModelCost("gemini-3-flash-preview"),
    );
    expect(officialModelCost("gemini-3.1-pro-preview-low")).toEqual(
      officialModelCost("gemini-3.1-pro-preview"),
    );
    expect(officialModelCost("gemini-3.6-flash-tiered")).toEqual(
      officialModelCost("gemini-3.6-flash"),
    );
  });

  test("resolves every Gemini ID observed from sub2api", () => {
    const modelIds = [
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "gemini-3-flash",
      "gemini-3-flash-preview",
      "gemini-3.1-flash-lite",
      "gemini-3.1-flash-lite-preview",
      "gemini-3.1-pro-preview",
      "gemini-3.1-pro-preview-low",
      "gemini-3.6-flash",
      "gemini-3.6-flash-tiered",
      "gemini-3.7-flash",
    ];
    expect(modelIds.filter(modelId => !officialModelCost(modelId))).toEqual([]);
  });
});
