/**
 * InsightEngine — Spec 55 §6 Insight layer.
 *
 * Generates Insights from Awareness + Memory data:
 * - Structural issues (from AwarenessEngine) → promoted immediately
 * - Drift events (from MemoryEngine) → must pass promotion rules
 *
 * Promotion rules (Spec 55 §6.3): a drift pattern must recur
 * `minOccurrences` times across `minDistinctContexts` different contexts
 * within `timeWindowMs` before it becomes a formal Insight.
 */

import type {
  AwarenessEngine,
  Insight,
  InsightEngine,
  InsightImpact,
  InsightPromotionConfig,
  SensorSignal,
  StructuralIssue,
} from "../types/life-system";

const DEFAULT_PROMOTION: InsightPromotionConfig = {
  minOccurrences: 3,
  minDistinctContexts: 2,
  timeWindowMs: 30 * 24 * 60 * 60 * 1000, // 30 days
  minConfidence: 0.7,
};

/** Tracks a drift candidate pending promotion */
interface DriftCandidate {
  key: string;
  entity: string;
  sensor: string;
  signals: SensorSignal[];
  contexts: Set<string>;
  maxDeviation: number;
  firstSeen: Date;
}

/** Maximum number of promoted insights to retain in memory */
const MAX_RETAINED_INSIGHTS = 200;

export interface InsightEngineOptions {
  awareness: AwarenessEngine;
  promotion?: Partial<InsightPromotionConfig>;
  /** Max insights to keep in memory. Oldest evicted first. Default: 200 */
  maxRetainedInsights?: number;
}

function createIdGenerator(): () => string {
  let counter = 0;
  return () => `insight_${Date.now()}_${++counter}`;
}

function deviationToImpact(deviation: number): InsightImpact {
  if (deviation >= 0.7) return "high";
  if (deviation >= 0.4) return "medium";
  return "low";
}

/** Derive a context key for distinctness counting */
function contextKey(signal: SensorSignal): string {
  const tenant = signal.context.tenantId ?? "default";
  const entity = signal.context.entity ?? signal.sensor;
  return `${tenant}:${entity}`;
}

export function createInsightEngine(opts: InsightEngineOptions): InsightEngine {
  const { awareness } = opts;
  const promotion: InsightPromotionConfig = { ...DEFAULT_PROMOTION, ...opts.promotion };
  const maxInsights = opts.maxRetainedInsights ?? MAX_RETAINED_INSIGHTS;
  const nextInsightId = createIdGenerator();

  const driftCandidates = new Map<string, DriftCandidate>();
  const promotedInsights: Insight[] = [];
  const promotedKeys = new Set<string>();

  /** Evict oldest insights when over capacity, cleaning up their keys */
  function enforceRetentionLimit(): void {
    while (promotedInsights.length > maxInsights) {
      promotedInsights.shift();
      // Note: we don't remove from promotedKeys — evicted insights
      // should not be re-generated. Keys only grow with distinct patterns.
    }
  }

  function recordDriftCandidate(signal: SensorSignal, deviation: number): void {
    const entity = (signal.context.entity as string | undefined) ?? signal.sensor;
    const key = `drift:${entity}:${signal.sensor}`;

    let candidate = driftCandidates.get(key);
    if (!candidate) {
      candidate = {
        key,
        entity,
        sensor: signal.sensor,
        signals: [],
        contexts: new Set(),
        maxDeviation: 0,
        firstSeen: signal.timestamp,
      };
      driftCandidates.set(key, candidate);
    }

    candidate.signals.push(signal);
    candidate.contexts.add(contextKey(signal));
    candidate.maxDeviation = Math.max(candidate.maxDeviation, deviation);
  }

  function pruneExpiredCandidates(): void {
    const cutoff = Date.now() - promotion.timeWindowMs;
    for (const [key, candidate] of driftCandidates) {
      // Remove signals outside the window
      candidate.signals = candidate.signals.filter((s) => s.timestamp.getTime() >= cutoff);
      if (candidate.signals.length === 0) {
        driftCandidates.delete(key);
      } else {
        // Recompute contexts from remaining signals (fix: stale contexts after pruning)
        candidate.contexts = new Set(candidate.signals.map((s) => contextKey(s)));
      }
    }
  }

  function tryPromoteDriftCandidates(): Insight[] {
    pruneExpiredCandidates();
    const newInsights: Insight[] = [];

    for (const [, candidate] of driftCandidates) {
      if (promotedKeys.has(candidate.key)) continue;

      const meetsOccurrences = candidate.signals.length >= promotion.minOccurrences;
      const meetsContexts = candidate.contexts.size >= promotion.minDistinctContexts;
      const avgConfidence =
        candidate.signals.reduce((sum, s) => sum + s.confidence, 0) / candidate.signals.length;
      const meetsConfidence = avgConfidence >= promotion.minConfidence;

      if (meetsOccurrences && meetsContexts && meetsConfidence) {
        const latestBaseline = candidate.signals[candidate.signals.length - 1]?.baseline;
        const insight: Insight = {
          id: nextInsightId(),
          type: "anomaly",
          confidence: avgConfidence,
          impact: deviationToImpact(candidate.maxDeviation),
          evidence: {
            signals: [...candidate.signals],
            baseline:
              latestBaseline != null
                ? {
                    entity: candidate.entity,
                    metric: "value",
                    value: latestBaseline,
                    calculatedAt: new Date(),
                  }
                : undefined,
            context: {
              sensor: candidate.sensor,
              occurrences: candidate.signals.length,
              distinctContexts: candidate.contexts.size,
              maxDeviation: candidate.maxDeviation,
            },
          },
          summary:
            `Drift detected on "${candidate.entity}" via sensor "${candidate.sensor}": ` +
            `${candidate.signals.length} occurrences, ` +
            `max deviation ${(candidate.maxDeviation * 100).toFixed(0)}%`,
          causality: "correlational",
          entity: candidate.entity,
          createdAt: new Date(),
        };

        promotedInsights.push(insight);
        promotedKeys.add(candidate.key);
        newInsights.push(insight);
        // Free candidate memory after promotion (#2 review fix)
        driftCandidates.delete(candidate.key);
      }
    }

    return newInsights;
  }

  function structuralToInsights(issues: StructuralIssue[]): Insight[] {
    const newInsights: Insight[] = [];

    // Build current structural keys to detect regressions (#4 review fix)
    const currentKeys = new Set(
      issues.map((i) => `structural:${i.kind}:${i.entity}:${i.target ?? ""}`),
    );

    // Clear promoted keys for structural issues that were resolved,
    // so they can be re-reported if they regress later
    for (const key of promotedKeys) {
      if (key.startsWith("structural:") && !currentKeys.has(key)) {
        promotedKeys.delete(key);
      }
    }

    for (const issue of issues) {
      const key = `structural:${issue.kind}:${issue.entity}:${issue.target ?? ""}`;
      if (promotedKeys.has(key)) continue;

      const insight: Insight = {
        id: nextInsightId(),
        type: "structural",
        confidence: 1.0,
        impact: "low",
        evidence: {
          signals: [],
          context: { kind: issue.kind, target: issue.target },
        },
        summary: issue.message,
        causality: "structural",
        entity: issue.entity,
        createdAt: new Date(),
      };

      promotedInsights.push(insight);
      promotedKeys.add(key);
      newInsights.push(insight);
    }

    return newInsights;
  }

  return {
    async generateInsights(): Promise<Insight[]> {
      const newInsights: Insight[] = [];

      // Structural insights (no promotion needed — Spec 55 §6.3)
      const structuralIssues = awareness.structuralCheck();
      newInsights.push(...structuralToInsights(structuralIssues));

      // Drift insights (require promotion)
      newInsights.push(...tryPromoteDriftCandidates());

      // Evict oldest insights if over retention limit (#2 review fix)
      enforceRetentionLimit();

      return newInsights;
    },

    recordDriftCandidate,

    getInsights(): Insight[] {
      return [...promotedInsights];
    },
  };
}
