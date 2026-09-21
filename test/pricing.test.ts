import { describe, expect, test } from "bun:test";
import {
  modelPricingStat,
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
    expect(cost.input).toBeCloseTo(0.2 * (1 / 0.75) * 0.25, 12);
    expect(cost.output).toBeCloseTo(1.2 * (1 / 0.75) * 0.25, 12);
    expect(cost.cacheRead).toBeCloseTo(0.02 * (1 / 0.75) * 0.25, 12);
    expect(cost.cacheWrite).toBeCloseTo(0.25 * (1 / 0.75) * 0.25, 12);
  });

  test("keeps distinct prices for different keys serving the same model", () => {
    const first = providerModelCost("gpt-5.6-luna", { cost: 1, accountCost: 0.8 }, 0.15)!;
    const second = providerModelCost("gpt-5.6-luna", { cost: 1, accountCost: 0.5 }, 0.3)!;
    expect(first.input).toBeCloseTo(0.2 * (1 / 0.8) * 0.15, 12);
    expect(second.input).toBeCloseTo(0.2 * (1 / 0.5) * 0.3, 12);
    expect(first.input).not.toBe(second.input);
  });
});
