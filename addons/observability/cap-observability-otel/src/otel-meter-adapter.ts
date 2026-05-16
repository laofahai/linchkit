/**
 * OpenTelemetry Meter adapter.
 *
 * Wraps `@opentelemetry/api`'s `Meter` so it satisfies LinchKit core's
 * `Meter` / `Counter` / `Histogram` interface from
 * `packages/core/src/observability/meter.ts`.
 *
 * Mapping:
 * - `Counter.add(value, attributes)` → OTel `Counter.add(value, attrs)`.
 * - `Histogram.record(value, attributes)` → OTel
 *   `Histogram.record(value, attrs)`.
 * - `InstrumentOptions.description` / `unit` are forwarded verbatim;
 *   OTel uses the same field names.
 *
 * No buffering or batching is added here — the OTel SDK's
 * `PeriodicExportingMetricReader` (configured by `sdk-bootstrap.ts`)
 * handles export cadence.
 */

import type {
  Counter,
  Histogram,
  InstrumentOptions,
  Meter,
  MetricAttributes,
} from "@linchkit/core/server";
import type {
  Attributes as OtelAttributes,
  Counter as OtelCounter,
  Histogram as OtelHistogram,
  Meter as OtelMeter,
} from "@opentelemetry/api";

// ── Counter wrapper ──────────────────────────────────────

/** Wraps an OTel `Counter` to satisfy LinchKit's `Counter` interface. */
export class OtelCounterAdapter implements Counter {
  constructor(private readonly inner: OtelCounter) {}

  add(value: number, attributes?: MetricAttributes): void {
    this.inner.add(value, attributes as OtelAttributes | undefined);
  }
}

// ── Histogram wrapper ────────────────────────────────────

/** Wraps an OTel `Histogram` to satisfy LinchKit's `Histogram` interface. */
export class OtelHistogramAdapter implements Histogram {
  constructor(private readonly inner: OtelHistogram) {}

  record(value: number, attributes?: MetricAttributes): void {
    this.inner.record(value, attributes as OtelAttributes | undefined);
  }
}

// ── Meter wrapper ────────────────────────────────────────

/**
 * Wraps an OTel `Meter` to satisfy LinchKit's `Meter` interface.
 *
 * The wrapped instruments are NOT cached — OTel's own meter
 * implementation deduplicates by name internally, so re-creating an
 * instrument with the same name is cheap and returns the same
 * underlying instrument.
 */
export class OtelMeterAdapter implements Meter {
  constructor(private readonly inner: OtelMeter) {}

  createCounter(name: string, options?: InstrumentOptions): Counter {
    return new OtelCounterAdapter(
      this.inner.createCounter(name, {
        description: options?.description,
        unit: options?.unit,
      }),
    );
  }

  createHistogram(name: string, options?: InstrumentOptions): Histogram {
    return new OtelHistogramAdapter(
      this.inner.createHistogram(name, {
        description: options?.description,
        unit: options?.unit,
      }),
    );
  }
}
