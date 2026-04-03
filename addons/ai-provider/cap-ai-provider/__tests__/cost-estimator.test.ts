/**
 * Tests for CostEstimator (cap-ai-provider)
 *
 * Covers:
 * - Default pricing lookup for well-known models
 * - Custom pricing registration and override
 * - Cost estimation calculation
 * - Prefix match fallback for versioned model IDs
 * - hasPricing / getPricing utilities
 */

import { describe, expect, it } from "bun:test";
import { CostEstimator, defaultCostEstimator } from "../src/cost-estimator";

describe("CostEstimator", () => {
  describe("Default pricing", () => {
    it("provides pricing for claude-sonnet-4-20250514", () => {
      const est = new CostEstimator();
      expect(est.hasPricing("claude-sonnet-4-20250514")).toBe(true);

      const pricing = est.getPricing("claude-sonnet-4-20250514");
      expect(pricing).toBeDefined();
      expect((pricing as NonNullable<typeof pricing>).inputPerToken).toBeGreaterThan(0);
      expect((pricing as NonNullable<typeof pricing>).outputPerToken).toBeGreaterThan(0);
    });

    it("provides pricing for claude-opus-4-20250514", () => {
      const est = new CostEstimator();
      expect(est.hasPricing("claude-opus-4-20250514")).toBe(true);
    });

    it("provides pricing for claude-haiku-4-5-20251001", () => {
      const est = new CostEstimator();
      expect(est.hasPricing("claude-haiku-4-5-20251001")).toBe(true);
    });

    it("provides pricing for gpt-4o", () => {
      const est = new CostEstimator();
      expect(est.hasPricing("gpt-4o")).toBe(true);
    });

    it("provides pricing for gpt-4o-mini", () => {
      const est = new CostEstimator();
      expect(est.hasPricing("gpt-4o-mini")).toBe(true);
    });

    it("returns undefined for unknown model", () => {
      const est = new CostEstimator();
      expect(est.hasPricing("unknown-model-xyz")).toBe(false);
      expect(est.getPricing("unknown-model-xyz")).toBeUndefined();
    });
  });

  describe("Cost estimation", () => {
    it("calculates cost from input and output tokens", () => {
      const est = new CostEstimator();

      // claude-sonnet-4: $3/M input, $15/M output
      const cost = est.estimateCost("claude-sonnet-4-20250514", 1_000_000, 1_000_000);
      expect(cost).toBeCloseTo(3 + 15, 2);
    });

    it("returns undefined for unknown model", () => {
      const est = new CostEstimator();
      expect(est.estimateCost("no-such-model", 100, 100)).toBeUndefined();
    });

    it("calculates zero cost when both token counts are zero", () => {
      const est = new CostEstimator();
      const cost = est.estimateCost("gpt-4o", 0, 0);
      expect(cost).toBe(0);
    });

    it("estimatePreCost returns same result as estimateCost", () => {
      const est = new CostEstimator();
      const actual = est.estimateCost("gpt-4o-mini", 5000, 1000);
      const pre = est.estimatePreCost("gpt-4o-mini", 5000, 1000);
      expect(pre).toBe(actual);
    });

    it("input tokens cost more for premium models (opus > sonnet > haiku)", () => {
      const est = new CostEstimator();
      const tokens = 1_000_000;

      const opusCost = est.estimateCost("claude-opus-4-20250514", tokens, 0) ?? 0;
      const sonnetCost = est.estimateCost("claude-sonnet-4-20250514", tokens, 0) ?? 0;
      const haikuCost = est.estimateCost("claude-haiku-4-5-20251001", tokens, 0) ?? 0;

      expect(opusCost).toBeGreaterThan(sonnetCost);
      expect(sonnetCost).toBeGreaterThan(haikuCost);
    });
  });

  describe("Custom pricing", () => {
    it("constructor accepts custom pricing overrides", () => {
      const est = new CostEstimator({
        "my-custom-model": {
          inputPerToken: 0.001,
          outputPerToken: 0.002,
        },
      });

      expect(est.hasPricing("my-custom-model")).toBe(true);
      const cost = est.estimateCost("my-custom-model", 100, 50);
      expect(cost).toBeCloseTo(0.001 * 100 + 0.002 * 50, 6);
    });

    it("custom pricing overrides default pricing for same model", () => {
      const customPrice = { inputPerToken: 999 / 1_000_000, outputPerToken: 999 / 1_000_000 };
      const est = new CostEstimator({ "gpt-4o": customPrice });

      const pricing = est.getPricing("gpt-4o");
      expect(pricing?.inputPerToken).toBe(999 / 1_000_000);
    });

    it("registerPricing adds new model at runtime", () => {
      const est = new CostEstimator();
      expect(est.hasPricing("runtime-model")).toBe(false);

      est.registerPricing("runtime-model", {
        inputPerToken: 0.5 / 1_000_000,
        outputPerToken: 1.5 / 1_000_000,
      });

      expect(est.hasPricing("runtime-model")).toBe(true);
      const cost = est.estimateCost("runtime-model", 1_000_000, 1_000_000);
      expect(cost).toBeCloseTo(0.5 + 1.5, 2);
    });

    it("registerPricing updates existing model pricing", () => {
      const est = new CostEstimator();
      est.registerPricing("gpt-4o", { inputPerToken: 0, outputPerToken: 0 });

      expect(est.estimateCost("gpt-4o", 1_000_000, 1_000_000)).toBe(0);
    });
  });

  describe("Prefix match fallback", () => {
    it("finds pricing by prefix for versioned model IDs", () => {
      const est = new CostEstimator({
        "my-model": { inputPerToken: 1 / 1_000_000, outputPerToken: 2 / 1_000_000 },
      });

      // Versioned variant of "my-model"
      expect(est.hasPricing("my-model-2025-01-01")).toBe(true);
      expect(est.estimateCost("my-model-2025-01-01", 1_000_000, 0)).toBeCloseTo(1, 2);
    });

    it("returns undefined when no prefix matches", () => {
      const est = new CostEstimator();
      expect(est.hasPricing("completely-unknown-xyz-2025")).toBe(false);
    });

    it("longest prefix match wins over shorter prefix", () => {
      const est = new CostEstimator({
        "custom-v1": { inputPerToken: 10 / 1_000_000, outputPerToken: 30 / 1_000_000 },
        "custom-v1-turbo": { inputPerToken: 2.5 / 1_000_000, outputPerToken: 10 / 1_000_000 },
      });

      // "custom-v1-turbo-2025-01" starts with both "custom-v1" and "custom-v1-turbo";
      // "custom-v1-turbo" is longer so it wins
      const pricing = est.getPricing("custom-v1-turbo-2025-01");
      expect(pricing?.inputPerToken).toBeCloseTo(2.5 / 1_000_000, 10);
    });
  });

  describe("defaultCostEstimator singleton", () => {
    it("is an instance of CostEstimator with default pricing", () => {
      expect(defaultCostEstimator).toBeInstanceOf(CostEstimator);
      expect(defaultCostEstimator.hasPricing("claude-sonnet-4-20250514")).toBe(true);
    });
  });
});
