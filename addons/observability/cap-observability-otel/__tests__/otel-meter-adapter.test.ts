/**
 * Tests for OtelMeterAdapter / OtelCounterAdapter / OtelHistogramAdapter.
 */

import { describe, expect, it } from "bun:test";
import type {
  Attributes as OtelAttributes,
  Counter as OtelCounter,
  Histogram as OtelHistogram,
  Meter as OtelMeter,
  MetricOptions as OtelMetricOptions,
} from "@opentelemetry/api";
import { OtelMeterAdapter } from "../src/otel-meter-adapter";

// ── Fakes ────────────────────────────────────────────────

interface CounterCall {
  value: number;
  attributes?: OtelAttributes;
}
interface HistogramCall {
  value: number;
  attributes?: OtelAttributes;
}

class FakeOtelCounter implements OtelCounter {
  calls: CounterCall[] = [];
  add(value: number, attributes?: OtelAttributes): void {
    this.calls.push({ value, attributes });
  }
}

class FakeOtelHistogram implements OtelHistogram {
  calls: HistogramCall[] = [];
  record(value: number, attributes?: OtelAttributes): void {
    this.calls.push({ value, attributes });
  }
}

class FakeOtelMeter implements OtelMeter {
  lastCounterName: string | undefined;
  lastCounterOptions: OtelMetricOptions | undefined;
  lastHistogramName: string | undefined;
  lastHistogramOptions: OtelMetricOptions | undefined;
  counter = new FakeOtelCounter();
  histogram = new FakeOtelHistogram();

  createCounter(name: string, options?: OtelMetricOptions): OtelCounter {
    this.lastCounterName = name;
    this.lastCounterOptions = options;
    return this.counter;
  }
  createHistogram(name: string, options?: OtelMetricOptions): OtelHistogram {
    this.lastHistogramName = name;
    this.lastHistogramOptions = options;
    return this.histogram;
  }
  // The rest of the OtelMeter interface (UpDownCounter / Gauge / Observable*)
  // is unused by the adapter — throw if accidentally called.
  createUpDownCounter(): never {
    throw new Error("createUpDownCounter not used by OtelMeterAdapter");
  }
  createGauge(): never {
    throw new Error("createGauge not used by OtelMeterAdapter");
  }
  createObservableCounter(): never {
    throw new Error("createObservableCounter not used by OtelMeterAdapter");
  }
  createObservableGauge(): never {
    throw new Error("createObservableGauge not used by OtelMeterAdapter");
  }
  createObservableUpDownCounter(): never {
    throw new Error("createObservableUpDownCounter not used by OtelMeterAdapter");
  }
  addBatchObservableCallback(): void {}
  removeBatchObservableCallback(): void {}
}

// ── Tests ────────────────────────────────────────────────

describe("OtelMeterAdapter.createCounter", () => {
  it("forwards name, description and unit", () => {
    const inner = new FakeOtelMeter();
    const meter = new OtelMeterAdapter(inner);

    meter.createCounter("linchkit.action.invocations", {
      description: "Number of action invocations",
      unit: "1",
    });

    expect(inner.lastCounterName).toBe("linchkit.action.invocations");
    expect(inner.lastCounterOptions).toEqual({
      description: "Number of action invocations",
      unit: "1",
    });
  });

  it("delegates add() to the underlying counter with attributes", () => {
    const inner = new FakeOtelMeter();
    const meter = new OtelMeterAdapter(inner);
    const counter = meter.createCounter("c");

    counter.add(3, { "linchkit.tenant_id": "t-1" });
    counter.add(1);

    expect(inner.counter.calls).toEqual([
      { value: 3, attributes: { "linchkit.tenant_id": "t-1" } },
      { value: 1, attributes: undefined },
    ]);
  });
});

describe("OtelMeterAdapter.createHistogram", () => {
  it("forwards name, description and unit", () => {
    const inner = new FakeOtelMeter();
    const meter = new OtelMeterAdapter(inner);

    meter.createHistogram("linchkit.action.duration_ms", {
      description: "Action duration distribution",
      unit: "ms",
    });

    expect(inner.lastHistogramName).toBe("linchkit.action.duration_ms");
    expect(inner.lastHistogramOptions).toEqual({
      description: "Action duration distribution",
      unit: "ms",
    });
  });

  it("delegates record() to the underlying histogram with attributes", () => {
    const inner = new FakeOtelMeter();
    const meter = new OtelMeterAdapter(inner);
    const histogram = meter.createHistogram("h", { unit: "ms" });

    histogram.record(12.5, { "linchkit.action": "submit_request" });
    histogram.record(7);

    expect(inner.histogram.calls).toEqual([
      { value: 12.5, attributes: { "linchkit.action": "submit_request" } },
      { value: 7, attributes: undefined },
    ]);
  });
});
