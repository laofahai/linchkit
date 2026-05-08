import type {
  AttentionBudget,
  AttentionBudgetConfig,
  ScoredCandidate,
  UsageImportanceGraph,
} from "../types/life-system";

const DEFAULT_CONFIG: AttentionBudgetConfig = {
  maxInsightsPerCycle: 10,
  ignoreDecay: 0.8,
  endorseBoost: 1.3,
};

/**
 * Numeric bands for the categorical InsightImpact (`low | medium | high`).
 * Single source of truth — InsightEngine reads these when ranking insights
 * via the budget so the band cutoffs do not drift between modules.
 */
export const IMPACT_BANDS: Readonly<Record<"low" | "medium" | "high", number>> = {
  low: 0.3,
  medium: 0.6,
  high: 1.0,
};

function impactNumeric(impact: number): number {
  // impact is a number; treat as low/medium/high bands
  if (impact <= IMPACT_BANDS.low) return IMPACT_BANDS.low;
  if (impact <= IMPACT_BANDS.medium) return IMPACT_BANDS.medium;
  return IMPACT_BANDS.high;
}

export function createAttentionBudget(
  config?: Partial<AttentionBudgetConfig>,
  usageGraph?: UsageImportanceGraph,
): AttentionBudget {
  const cfg: AttentionBudgetConfig = { ...DEFAULT_CONFIG, ...config };
  const typeWeights = new Map<string, number>();

  return {
    rank<T>(
      candidates: Array<{
        item: T;
        confidence: number;
        impact: number;
        entity?: string;
        type?: string;
      }>,
    ): ScoredCandidate<T>[] {
      const scored: ScoredCandidate<T>[] = candidates.map((c) => {
        const typeWeight = typeWeights.get(c.type ?? "") ?? 1.0;
        const importance =
          usageGraph && c.entity ? usageGraph.getImportance("entity", c.entity) || 0.5 : 0.5;
        const impact = impactNumeric(c.impact);
        const score = c.confidence * impact * importance * typeWeight;
        return {
          item: c.item,
          score,
          breakdown: { confidence: c.confidence, impact, importance, typeWeight },
        };
      });

      return scored.sort((a, b) => b.score - a.score).slice(0, cfg.maxInsightsPerCycle);
    },

    recordIgnore(type: string): void {
      const current = typeWeights.get(type) ?? 1.0;
      typeWeights.set(type, current * cfg.ignoreDecay);
    },

    recordEndorse(type: string): void {
      const current = typeWeights.get(type) ?? 1.0;
      typeWeights.set(type, current * cfg.endorseBoost);
    },
  };
}
