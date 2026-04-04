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

function impactNumeric(impact: number): number {
  // impact is a number; treat as low/medium/high bands
  if (impact <= 0.3) return 0.3;
  if (impact <= 0.6) return 0.6;
  return 1.0;
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
          usageGraph && c.entity ? usageGraph.getImportance("schema", c.entity) || 0.5 : 0.5;
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
