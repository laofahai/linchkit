import { describe, expect, it } from "bun:test";
import { CostEstimator, defaultCostEstimator } from "../src/ai/cost-estimator";

describe("CostEstimator", () => {
  describe("default pricing", () => {
    it("estimates cost for claude-sonnet-4-20250514", () => {
      const estimator = new CostEstimator();
      const cost = estimator.estimateCost("claude-sonnet-4-20250514", 1_000_000, 1_000_000);
      // input: 3/1M, output: 15/1M => 18 USD
      expect(cost).toBeCloseTo(18, 2);
    });

    it("estimates cost for claude-opus-4-20250514", () => {
      const estimator = new CostEstimator();
      const cost = estimator.estimateCost("claude-opus-4-20250514", 1_000_000, 1_000_000);
      // input: 15/1M, output: 75/1M => 90 USD
      expect(cost).toBeCloseTo(90, 2);
    });

    it("estimates cost for gpt-4o", () => {
      const estimator = new CostEstimator();
      const cost = estimator.estimateCost("gpt-4o", 1_000_000, 1_000_000);
      // input: 2.5/1M, output: 10/1M => 12.5 USD
      expect(cost).toBeCloseTo(12.5, 2);
    });

    it("estimates cost for gpt-4o-mini", () => {
      const estimator = new CostEstimator();
      const cost = estimator.estimateCost("gpt-4o-mini", 1_000_000, 1_000_000);
      // input: 0.15/1M, output: 0.6/1M => 0.75 USD
      expect(cost).toBeCloseTo(0.75, 4);
    });

    it("estimates cost for claude-haiku-4-5-20251001", () => {
      const estimator = new CostEstimator();
      const cost = estimator.estimateCost("claude-haiku-4-5-20251001", 1_000_000, 1_000_000);
      // input: 0.8/1M, output: 4/1M => 4.8 USD
      expect(cost).toBeCloseTo(4.8, 4);
    });
  });

  describe("zero tokens", () => {
    it("returns 0 for zero input and output tokens", () => {
      const estimator = new CostEstimator();
      const cost = estimator.estimateCost("gpt-4o", 0, 0);
      expect(cost).toBe(0);
    });

    it("returns cost for input only (zero output)", () => {
      const estimator = new CostEstimator();
      const cost = estimator.estimateCost("gpt-4o", 1_000_000, 0);
      expect(cost).toBeCloseTo(2.5, 4);
    });
  });

  describe("unknown model", () => {
    it("returns undefined for unknown model", () => {
      const estimator = new CostEstimator();
      const cost = estimator.estimateCost("unknown-model-xyz", 1000, 1000);
      expect(cost).toBeUndefined();
    });

    it("hasPricing returns false for unknown model", () => {
      const estimator = new CostEstimator();
      expect(estimator.hasPricing("unknown-model-xyz")).toBe(false);
    });
  });

  describe("prefix matching", () => {
    it("matches versioned model ID by prefix", () => {
      const estimator = new CostEstimator();
      // gpt-4o is registered; gpt-4o-2024-05-01 should match via prefix
      const cost = estimator.estimateCost("gpt-4o-2024-05-01", 1_000_000, 0);
      // Should match gpt-4o: input 2.5/1M
      expect(cost).toBeCloseTo(2.5, 4);
    });
  });

  describe("custom pricing", () => {
    it("registers custom pricing that overrides defaults", () => {
      const estimator = new CostEstimator({
        "gpt-4o": { inputPerToken: 1 / 1_000_000, outputPerToken: 2 / 1_000_000 },
      });
      const cost = estimator.estimateCost("gpt-4o", 1_000_000, 1_000_000);
      expect(cost).toBeCloseTo(3, 4);
    });

    it("registers new model pricing not in defaults", () => {
      const estimator = new CostEstimator({
        "my-custom-model": { inputPerToken: 5 / 1_000_000, outputPerToken: 10 / 1_000_000 },
      });
      expect(estimator.hasPricing("my-custom-model")).toBe(true);
      const cost = estimator.estimateCost("my-custom-model", 1_000_000, 0);
      expect(cost).toBeCloseTo(5, 4);
    });

    it("registerPricing updates pricing at runtime", () => {
      const estimator = new CostEstimator();
      estimator.registerPricing("runtime-model", {
        inputPerToken: 0.5 / 1_000_000,
        outputPerToken: 1 / 1_000_000,
      });
      expect(estimator.hasPricing("runtime-model")).toBe(true);
      const pricing = estimator.getPricing("runtime-model");
      expect(pricing?.inputPerToken).toBeCloseTo(0.5 / 1_000_000, 10);
    });
  });

  describe("estimatePreCost", () => {
    it("behaves identically to estimateCost", () => {
      const estimator = new CostEstimator();
      const a = estimator.estimateCost("gpt-4o", 500, 200);
      const b = estimator.estimatePreCost("gpt-4o", 500, 200);
      expect(a).toBe(b);
    });
  });

  describe("getPricing", () => {
    it("returns pricing for known model", () => {
      const estimator = new CostEstimator();
      const pricing = estimator.getPricing("gpt-4o");
      expect(pricing).toBeDefined();
      expect(pricing?.inputPerToken).toBeGreaterThan(0);
      expect(pricing?.outputPerToken).toBeGreaterThan(0);
    });

    it("returns undefined for unknown model", () => {
      const estimator = new CostEstimator();
      expect(estimator.getPricing("no-such-model")).toBeUndefined();
    });
  });

  describe("defaultCostEstimator singleton", () => {
    it("is defined and has default pricing", () => {
      expect(defaultCostEstimator).toBeDefined();
      expect(defaultCostEstimator.hasPricing("gpt-4o")).toBe(true);
    });
  });
});
