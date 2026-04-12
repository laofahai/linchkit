/**
 * purchase_rejection_pattern Sensor — Spec 55 §3.3 (Evolution Path A, Task 1)
 *
 * Counts rejection EVENTS over a rolling 30-day window and emits a SensorSignal
 * whose `value` is the number of `reject_purchase_request` action invocations
 * in that window.
 *
 * Why event-based rather than current-state-based:
 *   A purchase_request that was rejected and then resubmitted has
 *   `status="pending"` again — the rejection moment is no longer visible in
 *   the current row state. Counting `purchase_request.status="rejected"`
 *   therefore systematically undercounts the friction signal we care about.
 *   Querying `execution_log` for `action_name="reject_purchase_request"` /
 *   `status="succeeded"` captures every rejection event, regardless of what
 *   the request looks like today.
 *
 * Memory layer is responsible for computing baseline / deviation across
 * cycles; this sensor only reports the raw observation plus a confidence
 * estimate scaled with sample size.
 */

import type { SensorContext, SensorSignal } from "@linchkit/core";
import { defineSensor } from "@linchkit/core";

/** Rolling window for rejection counting (30 days). */
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Minimum rejected-event count above which we treat the signal as high-confidence. */
const HIGH_CONFIDENCE_THRESHOLD = 3;

/** Confidence values (0–1). */
const CONFIDENCE_LOW = 0.5;
const CONFIDENCE_HIGH = 0.8;

/** Subset of execution_log fields the sensor needs.
 *  See addons/adapter-server/cap-adapter-server/src/system-schemas.ts:20-103. */
interface ExecutionLogRecord {
  action_name?: string;
  status?: string;
  completed_at?: Date | string | null;
}

export const purchaseRejectionPattern = defineSensor({
  name: "purchase_rejection_pattern",
  source: "event_bus",
  entity: "purchase_request",

  async detect(ctx: SensorContext): Promise<SensorSignal | null> {
    if (!ctx.query) return null;

    const windowEnd = ctx.timestamp;
    const windowStart = new Date(windowEnd.getTime() - WINDOW_MS);

    // DataProvider.query treats `filter` as a key-equality map
    // (see DataProvider in packages/core/src/engine/action-engine.ts).
    // We post-filter on `completed_at` because a date-range predicate is
    // not part of the simple equality filter contract.
    //
    // Querying the action invocation log captures every rejection event,
    // even when the underlying purchase_request was later resubmitted and
    // is no longer in `status="rejected"`.
    const records = await ctx.query<ExecutionLogRecord>("execution_log", {
      action_name: "reject_purchase_request",
      status: "succeeded",
    });

    // Exclude records with null/missing/invalid completed_at. A successful
    // execution must have a completed_at; a missing one is data corruption,
    // not a legitimate rejection event. Excluding (rather than including) is
    // the conservative choice: we under-report rather than spike the signal
    // and trigger a false positive insight.
    //
    // Also exclude future timestamps (> ctx.timestamp). A completed_at after
    // the cycle's reference time indicates clock skew or data corruption, not
    // a legitimate event in the window we are measuring.
    const recentRejections = records.filter((record) => {
      const raw = record.completed_at;
      if (raw == null) return false;
      const ts = raw instanceof Date ? raw : new Date(raw);
      if (Number.isNaN(ts.getTime())) return false;
      return ts.getTime() >= windowStart.getTime() && ts.getTime() <= windowEnd.getTime();
    });

    const value = recentRejections.length;

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
