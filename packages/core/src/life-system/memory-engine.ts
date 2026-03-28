/**
 * MemoryEngine — Spec 55 §4 Memory layer.
 *
 * Responsibilities:
 * - Ingest SensorSignals and persist them via MemoryStore
 * - Compute sliding-window baselines per (schema, metric) pair
 * - Detect drift by comparing observed values against stored baselines
 */

import type { Baseline, MemoryStore, SensorSignal } from "../types/life-system";
import type { InMemoryMemoryStore } from "./in-memory-memory-store";

const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_DRIFT_THRESHOLD = 0.3;

export interface MemoryEngineOptions {
  store: MemoryStore;
  /** Sliding window size in days for baseline computation. Default: 30. */
  windowSize?: number;
  /** Deviation fraction above which drift is flagged. Default: 0.3 (30%). */
  driftThreshold?: number;
}

export class MemoryEngine {
  private readonly store: MemoryStore;
  private readonly windowSize: number;
  private readonly driftThreshold: number;

  constructor(opts: MemoryEngineOptions) {
    this.store = opts.store;
    this.windowSize = opts.windowSize ?? DEFAULT_WINDOW_DAYS;
    this.driftThreshold = opts.driftThreshold ?? DEFAULT_DRIFT_THRESHOLD;
  }

  /**
   * Ingest a SensorSignal: persist it to the store, then recompute the baseline
   * for the sensor's (schema, metric) pair.
   */
  async ingest(signal: SensorSignal): Promise<void> {
    await this.store.recordSignal({
      type: signal.sensor,
      source: signal.source,
      timestamp: signal.timestamp,
      payload: {
        value: signal.value,
        baseline: signal.baseline,
        deviation: signal.deviation,
        confidence: signal.confidence,
        schema: signal.context.schema,
        metric: signal.context.metric,
        ...signal.context,
      },
    });

    // Recompute baseline after new data arrives
    const schema = (signal.context.schema as string | undefined) ?? signal.sensor;
    const metric = (signal.context.metric as string | undefined) ?? "value";
    await this.computeBaseline(schema, metric);
  }

  /**
   * Compute and persist a sliding-window baseline for (schema, metric).
   *
   * Algorithm: arithmetic mean of `value` fields from signals within the
   * last `windowSize` days. Falls back to the current signal value when the
   * window is empty.
   */
  async computeBaseline(schema: string, metric: string): Promise<Baseline> {
    const since = new Date(Date.now() - this.windowSize * 24 * 60 * 60 * 1000);

    // Use extended getSignals if available (InMemoryMemoryStore), otherwise fall back
    const extStore = this.store as Partial<InMemoryMemoryStore>;
    const signals = extStore.getSignals
      ? await extStore.getSignals({ schema, since })
      : [];

    const values = signals
      .map((s) => {
        const p = s.payload as Record<string, unknown> | null;
        return typeof p?.value === "number" ? p.value : null;
      })
      .filter((v): v is number => v !== null);

    const avg =
      values.length > 0
        ? values.reduce((sum, v) => sum + v, 0) / values.length
        : 0;

    const baseline: Baseline = {
      schema,
      metric,
      value: avg,
      calculatedAt: new Date(),
    };

    await this.store.updateBaseline(baseline);
    return baseline;
  }

  /**
   * Detect whether a signal's value has drifted beyond the configured threshold
   * relative to the stored baseline.
   *
   * Drift formula: |value - baseline| / max(baseline, 1)
   * Returns drifted=false when no baseline exists yet (first observation).
   */
  async detectDrift(
    signal: SensorSignal,
  ): Promise<{ drifted: boolean; deviation: number }> {
    const schema = (signal.context.schema as string | undefined) ?? signal.sensor;
    const metric = (signal.context.metric as string | undefined) ?? "value";

    const stored = await this.store.getBaseline(schema, metric);

    if (!stored) {
      // No baseline yet — treat first observation as baseline, no drift
      return { drifted: false, deviation: 0 };
    }

    const denominator = stored.value === 0 ? 1 : Math.abs(stored.value);
    const deviation = Math.abs(signal.value - stored.value) / denominator;
    const drifted = deviation > this.driftThreshold;

    return { drifted, deviation };
  }

  /** Retrieve the stored baseline for (schema, metric). Delegates to store. */
  async getBaseline(schema: string, metric: string): Promise<Baseline | null> {
    return this.store.getBaseline(schema, metric);
  }
}
