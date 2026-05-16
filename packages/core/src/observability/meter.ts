/**
 * Meter — OTel-compatible metrics seam (Spec 28 M3 / issue #130).
 *
 * Mirrors the shape of `@opentelemetry/api`'s `Meter` + `Counter` +
 * `Histogram` so a future `cap-otel` adapter can plug in without
 * touching call sites. Phase 1 ships interfaces + a no-op
 * implementation only.
 *
 * Relationship with the existing `MetricsCollector` (./metrics.ts):
 * - `MetricsCollector` is LinchKit's own counters/gauges/histograms API
 *   used by CommandLayer for in-process telemetry and the alert engine.
 * - `Meter` is the OTel-aligned seam — when the adapter ships, the
 *   adapter will subscribe to `MetricsCollector` events (or wrap it)
 *   and forward to OTLP. Two surfaces, one direction of data flow.
 *   Keeping them separate avoids pinning core's internal API to OTel's
 *   versioning.
 */

// ── Attribute bag ────────────────────────────────────────

/** Attribute value types accepted on metric instruments. */
export type MetricAttributeValue =
  | string
  | number
  | boolean
  | readonly string[]
  | readonly number[]
  | readonly boolean[];

/** Attribute bag attached to a metric observation. */
export type MetricAttributes = Record<string, MetricAttributeValue>;

// ── Instruments ──────────────────────────────────────────

/** Options accepted when creating an instrument. */
export interface InstrumentOptions {
  /** Human-readable description. */
  description?: string;
  /**
   * Unit string following UCUM (e.g. `ms`, `By`, `1`). OTel recommends
   * `1` for dimensionless instruments.
   */
  unit?: string;
}

/**
 * Monotonic counter — increments only. Mirrors OTel's `Counter`.
 */
export interface Counter {
  /** Add a positive delta with optional attributes. */
  add(value: number, attributes?: MetricAttributes): void;
}

/**
 * Histogram instrument — records distributions of values. Mirrors
 * OTel's `Histogram`.
 */
export interface Histogram {
  /** Record an observation with optional attributes. */
  record(value: number, attributes?: MetricAttributes): void;
}

// ── Meter ────────────────────────────────────────────────

/**
 * Meter — factory for counter / histogram instruments. Mirrors the
 * subset of `@opentelemetry/api`'s `Meter` we plan to use.
 */
export interface Meter {
  createCounter(name: string, options?: InstrumentOptions): Counter;
  createHistogram(name: string, options?: InstrumentOptions): Histogram;
}

// ── Noop implementation ──────────────────────────────────

const NOOP_COUNTER: Counter = {
  add: () => {},
};

const NOOP_HISTOGRAM: Histogram = {
  record: () => {},
};

/**
 * Default no-op meter — returns shared singleton instruments. Used as
 * the registry default; replaced via `setObservability(...)` once an
 * OTel adapter is wired in.
 */
export class NoopMeter implements Meter {
  createCounter(_name: string, _options?: InstrumentOptions): Counter {
    return NOOP_COUNTER;
  }
  createHistogram(_name: string, _options?: InstrumentOptions): Histogram {
    return NOOP_HISTOGRAM;
  }
}

/** Singleton instance to avoid per-call allocation of the meter itself. */
export const noopMeter: Meter = new NoopMeter();
