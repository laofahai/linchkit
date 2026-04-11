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
  metric: string;
  sensor: string;
  signals: SensorSignal[];
  /** Per-signal drift deviation from MemoryEngine (parallel to signals array) */
  driftDeviations: number[];
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

/** Derive a context key for distinctness counting.
 *  Uses tenantId + source to support both multi-tenant and single-tenant setups. */
function contextKey(signal: SensorSignal): string {
  const tenant = signal.context.tenantId ?? "default";
  const source = signal.source ?? "unknown";
  return `${tenant}:${source}`;
}

export function createInsightEngine(opts: InsightEngineOptions): InsightEngine {
  const { awareness } = opts;
  const promotion: InsightPromotionConfig = { ...DEFAULT_PROMOTION, ...opts.promotion };
  const maxInsights = Math.max(1, opts.maxRetainedInsights ?? MAX_RETAINED_INSIGHTS);
  const nextInsightId = createIdGenerator();

  const driftCandidates = new Map<string, DriftCandidate>();
  const promotedInsights: Insight[] = [];
  const promotedKeys = new Set<string>();

  /** Evict oldest insights when over capacity, cleaning up their keys */
  function enforceRetentionLimit(): void {
    while (promotedInsights.length > maxInsights) {
      const evicted = promotedInsights.shift();
      // Remove key so the pattern can re-alert if it recurs
      if (evicted) {
        const evictedKey = findKeyForInsight(evicted);
        if (evictedKey) promotedKeys.delete(evictedKey);
      }
    }
  }

  /** Reverse-lookup: find the promotedKeys entry for an evicted insight */
  function findKeyForInsight(insight: Insight): string | undefined {
    if (insight.type === "structural") {
      const kind = insight.evidence.context.kind;
      const target = insight.evidence.context.target ?? "";
      return `structural:${kind}:${insight.entity}:${target}`;
    }
    const sensor = insight.evidence.context.sensor;
    const metric = insight.evidence.context.metric ?? "value";
    return `drift:${insight.entity}:${metric}:${sensor}`;
  }

  function recordDriftCandidate(signal: SensorSignal, deviation: number): void {
    const entity = (signal.context.entity as string | undefined) ?? signal.sensor;
    const metric = (signal.context.metric as string | undefined) ?? "value";
    const key = `drift:${entity}:${metric}:${signal.sensor}`;

    let candidate = driftCandidates.get(key);
    if (!candidate) {
      candidate = {
        key,
        entity,
        metric,
        sensor: signal.sensor,
        signals: [],
        driftDeviations: [],
        contexts: new Set(),
        maxDeviation: 0,
        firstSeen: signal.timestamp,
      };
      driftCandidates.set(key, candidate);
    }

    candidate.signals.push(signal);
    candidate.driftDeviations.push(deviation);
    candidate.contexts.add(contextKey(signal));
    candidate.maxDeviation = Math.max(candidate.maxDeviation, deviation);
  }

  function pruneExpiredCandidates(): void {
    const cutoff = Date.now() - promotion.timeWindowMs;
    for (const [key, candidate] of driftCandidates) {
      // Filter both signals and their paired driftDeviations
      const kept: { signal: SensorSignal; deviation: number }[] = [];
      for (let i = 0; i < candidate.signals.length; i++) {
        const s = candidate.signals[i];
        const d = candidate.driftDeviations[i];
        if (s && d !== undefined && s.timestamp.getTime() >= cutoff) {
          kept.push({ signal: s, deviation: d });
        }
      }
      if (kept.length === 0) {
        driftCandidates.delete(key);
      } else {
        candidate.signals = kept.map((k) => k.signal);
        candidate.driftDeviations = kept.map((k) => k.deviation);
        candidate.contexts = new Set(candidate.signals.map((s) => contextKey(s)));
        candidate.maxDeviation = Math.max(...candidate.driftDeviations);
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
                    metric: candidate.metric,
                    value: latestBaseline,
                    calculatedAt: new Date(),
                  }
                : undefined,
            context: {
              sensor: candidate.sensor,
              metric: candidate.metric,
              occurrences: candidate.signals.length,
              distinctContexts: candidate.contexts.size,
              maxDeviation: candidate.maxDeviation,
            },
          },
          summary:
            `Drift detected on "${candidate.entity}" (metric: ${candidate.metric}) ` +
            `via sensor "${candidate.sensor}": ` +
            `${candidate.signals.length} occurrences, ` +
            `max deviation ${(candidate.maxDeviation * 100).toFixed(0)}%`,
          causality: "correlational",
          entity: candidate.entity,
          createdAt: new Date(),
        };

        promotedInsights.push(insight);
        promotedKeys.add(candidate.key);
        newInsights.push(insight);
        // Free candidate memory after promotion
        driftCandidates.delete(candidate.key);
      }
    }

    return newInsights;
  }

  function structuralToInsights(issues: StructuralIssue[]): Insight[] {
    const newInsights: Insight[] = [];

    // Build current structural keys to detect regressions
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

      // Evict oldest insights if over retention limit
      enforceRetentionLimit();

      return newInsights;
    },

    recordDriftCandidate,

    getInsights(): Insight[] {
      return [...promotedInsights];
    },
  };
}
