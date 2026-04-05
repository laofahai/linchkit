/**
 * AI Cost Estimator
 *
 * Provides token-based cost estimation for AI model usage.
 * Pricing is approximate and based on publicly available pricing as of 2025.
 * Custom pricing can be registered for any model.
 *
 * See spec 36_ai_service.md §5 — usage tracking and cost control.
 */

// ── Model pricing ──────────────────────────────────────────

/** Per-token pricing for a model (USD per token) */
export interface ModelPricing {
  /** Cost per input token in USD */
  inputPerToken: number;
  /** Cost per output token in USD */
  outputPerToken: number;
}

/** Default pricing table for well-known models (USD per token) */
const DEFAULT_PRICING: Record<string, ModelPricing> = {
  // Anthropic models
  "claude-opus-4-20250514": {
    inputPerToken: 15 / 1_000_000,
    outputPerToken: 75 / 1_000_000,
  },
  "claude-sonnet-4-20250514": {
    inputPerToken: 3 / 1_000_000,
    outputPerToken: 15 / 1_000_000,
  },
  "claude-haiku-4-5-20251001": {
    inputPerToken: 0.8 / 1_000_000,
    outputPerToken: 4 / 1_000_000,
  },

  // OpenAI models
  "gpt-4o": {
    inputPerToken: 2.5 / 1_000_000,
    outputPerToken: 10 / 1_000_000,
  },
  "gpt-4o-mini": {
    inputPerToken: 0.15 / 1_000_000,
    outputPerToken: 0.6 / 1_000_000,
  },
  o3: {
    inputPerToken: 10 / 1_000_000,
    outputPerToken: 40 / 1_000_000,
  },
  "o3-mini": {
    inputPerToken: 1.1 / 1_000_000,
    outputPerToken: 4.4 / 1_000_000,
  },
};

// ── CostEstimator ───────────────────────────────────────────

export class CostEstimator {
  private readonly pricing: Map<string, ModelPricing>;

  constructor(customPricing?: Record<string, ModelPricing>) {
    this.pricing = new Map(Object.entries(DEFAULT_PRICING));

    // Register custom pricing (overrides defaults)
    if (customPricing) {
      for (const [model, price] of Object.entries(customPricing)) {
        this.pricing.set(model, price);
      }
    }
  }

  /**
   * Estimate cost for a completed AI call.
   * Returns undefined if pricing is not available for the model.
   */
  estimateCost(modelId: string, inputTokens: number, outputTokens: number): number | undefined {
    const pricing = this.findPricing(modelId);
    if (!pricing) return undefined;

    return pricing.inputPerToken * inputTokens + pricing.outputPerToken * outputTokens;
  }

  /**
   * Estimate cost before execution (using estimated input tokens).
   * Useful for budget pre-checks.
   */
  estimatePreCost(
    modelId: string,
    estimatedInputTokens: number,
    estimatedOutputTokens: number,
  ): number | undefined {
    return this.estimateCost(modelId, estimatedInputTokens, estimatedOutputTokens);
  }

  /** Register or update pricing for a model */
  registerPricing(modelId: string, pricing: ModelPricing): void {
    this.pricing.set(modelId, pricing);
  }

  /** Check if pricing is available for a model */
  hasPricing(modelId: string): boolean {
    return this.findPricing(modelId) !== undefined;
  }

  /** Get pricing for a model (exact match or prefix match) */
  getPricing(modelId: string): ModelPricing | undefined {
    return this.findPricing(modelId);
  }

  /**
   * Find pricing with fallback: exact match first, then prefix match.
   * This handles versioned model IDs (e.g. 'gpt-4o-2024-05-01' → 'gpt-4o').
   */
  private findPricing(modelId: string): ModelPricing | undefined {
    // Exact match
    if (this.pricing.has(modelId)) {
      return this.pricing.get(modelId);
    }

    // Prefix match: find the longest registered model ID that is a prefix of the requested one
    let bestMatch: ModelPricing | undefined;
    let bestLength = 0;

    for (const [registeredId, pricing] of this.pricing) {
      if (modelId.startsWith(registeredId) && registeredId.length > bestLength) {
        bestMatch = pricing;
        bestLength = registeredId.length;
      }
    }

    return bestMatch;
  }
}

/** Default singleton cost estimator */
export const defaultCostEstimator = new CostEstimator();
