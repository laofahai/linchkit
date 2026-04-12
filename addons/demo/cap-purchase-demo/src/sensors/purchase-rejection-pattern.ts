/**
 * purchase_rejection_pattern Sensor — Spec 55 §3.3 (Evolution Path A, Task 1)
 *
 * Observes the rate of rejected purchase requests over a rolling time window
 * and emits a SensorSignal whose `value` is the count of rejections in window.
 *
 * Memory layer is responsible for computing the baseline / deviation across
 * cycles; this sensor only reports the raw observation plus a confidence
 * estimate scaled with sample size.
 */

import type { SensorContext, SensorSignal } from "@linchkit/core";
import { defineSensor } from "@linchkit/core";

/** Rolling window for rejection counting (30 days). */
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Minimum rejected-record count above which we treat the signal as high-confidence. */
const HIGH_CONFIDENCE_THRESHOLD = 3;

/** Confidence values (0–1). */
const CONFIDENCE_LOW = 0.5;
const CONFIDENCE_HIGH = 0.8;

/** Subset of purchase_request fields the sensor needs. */
interface RejectedRecord {
  status?: string;
  updated_at?: Date | string | null;
}

export const purchaseRejectionPattern = defineSensor({
  name: "purchase_rejection_pattern",
  source: "event_bus",
  entity: "purchase_request",

  async detect(ctx: SensorContext): Promise<SensorSignal | null> {
    if (!ctx.query) return null;

    const windowStart = new Date(ctx.timestamp.getTime() - WINDOW_MS);

    // DataProvider.query treats `filter` as a key-equality map
    // (see DataProvider in packages/core/src/engine/action-engine.ts).
    // We post-filter on `updated_at` because a date-range predicate is
    // not part of the simple equality filter contract.
    const rejected = await ctx.query<RejectedRecord>("purchase_request", {
      status: "rejected",
    });

    const recentRejected = rejected.filter((record) => {
      const raw = record.updated_at;
      if (raw == null) return true; // include records with no timestamp (treat as recent)
      const ts = raw instanceof Date ? raw : new Date(raw);
      if (Number.isNaN(ts.getTime())) return true;
      return ts.getTime() >= windowStart.getTime();
    });

    const value = recentRejected.length;

    return {
      sensor: "purchase_rejection_pattern",
      source: "event_bus",
      timestamp: ctx.timestamp,
      value,
      // Baseline + deviation are filled in by MemoryEngine during drift detection.
      baseline: 0,
      deviation: 0,
      confidence: value >= HIGH_CONFIDENCE_THRESHOLD ? CONFIDENCE_HIGH : CONFIDENCE_LOW,
      context: {
        entity: "purchase_request",
        metric: "rejection_count",
        windowMs: WINDOW_MS,
        windowStart: windowStart.toISOString(),
        tenantId: ctx.tenantId,
      },
    };
  },
});
