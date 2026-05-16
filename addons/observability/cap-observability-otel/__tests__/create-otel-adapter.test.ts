/**
 * Tests for createOtelAdapter — verifies the factory wires a fake OTel
 * tracer / meter into an Observability bundle without ever touching
 * the global OTel provider registry.
 */

import { describe, expect, it } from "bun:test";
import type {
  Attributes as OtelAttributes,
  Counter as OtelCounter,
  Histogram as OtelHistogram,
  Meter as OtelMeter,
  MetricOptions as OtelMetricOptions,
  Span as OtelSpan,
  SpanContext as OtelSpanContext,
  SpanOptions as OtelSpanOptions,
  SpanStatus as OtelSpanStatus,
  Tracer as OtelTracer,
  TimeInput,
} from "@opentelemetry/api";
import { SpanStatusCode as OtelSpanStatusCode } from "@opentelemetry/api";
import { capObservabilityOtel } from "../src/capability";
import { createOtelAdapter } from "../src/create-otel-adapter";

// ── Minimal fakes (same shape as the dedicated adapter tests) ────

class FakeOtelSpan implements OtelSpan {
  attributes: OtelAttributes = {};
  status: OtelSpanStatus = { code: OtelSpanStatusCode.UNSET };
  ended = false;

  setAttribute(key: string, value: OtelAttributes[string]): this {
    this.attributes[key] = value;
    return this;
  }
  setAttributes(attrs: OtelAttributes): this {
    Object.assign(this.attributes, attrs);
    return this;
  }
  addEvent(): this {
    return this;
  }
  addLink(): this {
    return this;
  }
  addLinks(): this {
    return this;
  }
  setStatus(status: OtelSpanStatus): this {
    this.status = status;
    return this;
  }
  updateName(): this {
    return this;
  }
  end(_endTime?: TimeInput): void {
    this.ended = true;
  }
  isRecording(): boolean {
    return !this.ended;
  }
  recordException(): void {}
  spanContext(): OtelSpanContext {
    return {
      traceId: "00000000000000000000000000000000",
      spanId: "0000000000000000",
      traceFlags: 0,
    };
  }
}

class FakeOtelTracer implements OtelTracer {
  resolvedAs: { name: string; version?: string } | undefined;
  lastSpanName: string | undefined;
  lastOptions: OtelSpanOptions | undefined;

  startSpan(name: string, options?: OtelSpanOptions): OtelSpan {
    this.lastSpanName = name;
    this.lastOptions = options;
    return new FakeOtelSpan();
  }
  startActiveSpan(): never {
    throw new Error("unused");
  }
}

class FakeCounter implements OtelCounter {
  calls: Array<{ value: number; attributes?: OtelAttributes }> = [];
  add(value: number, attributes?: OtelAttributes): void {
    this.calls.push({ value, attributes });
  }
}

class FakeHistogram implements OtelHistogram {
  calls: Array<{ value: number; attributes?: OtelAttributes }> = [];
  record(value: number, attributes?: OtelAttributes): void {
    this.calls.push({ value, attributes });
  }
}

class FakeOtelMeter implements OtelMeter {
  resolvedAs: { name: string; version?: string } | undefined;
  counter = new FakeCounter();
  histogram = new FakeHistogram();
  lastCounterOptions: OtelMetricOptions | undefined;
  lastHistogramOptions: OtelMetricOptions | undefined;

  createCounter(_name: string, options?: OtelMetricOptions): OtelCounter {
    this.lastCounterOptions = options;
    return this.counter;
  }
  createHistogram(_name: string, options?: OtelMetricOptions): OtelHistogram {
    this.lastHistogramOptions = options;
    return this.histogram;
  }
  createUpDownCounter(): never {
    throw new Error("unused");
  }
  createGauge(): never {
    throw new Error("unused");
  }
  createObservableCounter(): never {
    throw new Error("unused");
  }
  createObservableGauge(): never {
    throw new Error("unused");
  }
  createObservableUpDownCounter(): never {
    throw new Error("unused");
  }
  addBatchObservableCallback(): void {}
  removeBatchObservableCallback(): void {}
}

// ── Tests ────────────────────────────────────────────────

describe("createOtelAdapter", () => {
  it("returns a frozen Observability bundle with tracer + meter", () => {
    const tracer = new FakeOtelTracer();
    const meter = new FakeOtelMeter();

    const bundle = createOtelAdapter({
      serviceName: "test-service",
      tracerProvider: () => tracer,
      meterProvider: () => meter,
    });

    expect(bundle.tracer).toBeDefined();
    expect(bundle.meter).toBeDefined();
    expect(Object.isFrozen(bundle)).toBe(true);
  });

  it("passes serviceName + serviceVersion to the resolvers", () => {
    let tracerArgs: { name: string; version?: string } | undefined;
    let meterArgs: { name: string; version?: string } | undefined;

    createOtelAdapter({
      serviceName: "linchkit-server",
      serviceVersion: "0.2.0",
      tracerProvider: (name, version) => {
        tracerArgs = { name, version };
        return new FakeOtelTracer();
      },
      meterProvider: (name, version) => {
        meterArgs = { name, version };
        return new FakeOtelMeter();
      },
    });

    expect(tracerArgs).toEqual({ name: "linchkit-server", version: "0.2.0" });
    expect(meterArgs).toEqual({ name: "linchkit-server", version: "0.2.0" });
  });

  it("defaults serviceName to 'linchkit' when not provided", () => {
    let resolvedName: string | undefined;

    createOtelAdapter({
      tracerProvider: (name) => {
        resolvedName = name;
        return new FakeOtelTracer();
      },
      meterProvider: () => new FakeOtelMeter(),
    });

    expect(resolvedName).toBe("linchkit");
  });

  it("tracer.startSpan reaches the underlying OTel tracer", () => {
    const tracer = new FakeOtelTracer();
    const bundle = createOtelAdapter({
      tracerProvider: () => tracer,
      meterProvider: () => new FakeOtelMeter(),
    });

    bundle.tracer.startSpan("linchkit.test", {
      attributes: { "linchkit.kind": "unit" },
    });

    expect(tracer.lastSpanName).toBe("linchkit.test");
    expect(tracer.lastOptions?.attributes).toEqual({ "linchkit.kind": "unit" });
  });

  it("counter and histogram reach the underlying OTel meter", () => {
    const meter = new FakeOtelMeter();
    const bundle = createOtelAdapter({
      tracerProvider: () => new FakeOtelTracer(),
      meterProvider: () => meter,
    });

    const counter = bundle.meter.createCounter("c", { description: "d", unit: "1" });
    counter.add(5, { tenant: "t-1" });

    const histogram = bundle.meter.createHistogram("h", { unit: "ms" });
    histogram.record(42);

    expect(meter.lastCounterOptions).toEqual({ description: "d", unit: "1" });
    expect(meter.lastHistogramOptions).toEqual({ description: undefined, unit: "ms" });
    expect(meter.counter.calls).toEqual([{ value: 5, attributes: { tenant: "t-1" } }]);
    expect(meter.histogram.calls).toEqual([{ value: 42, attributes: undefined }]);
  });
});

describe("capObservabilityOtel descriptor", () => {
  it("declares the expected identity fields", () => {
    expect(capObservabilityOtel.name).toBe("cap-observability-otel");
    expect(capObservabilityOtel.type).toBe("standard");
    expect(capObservabilityOtel.category).toBe("system");
    expect(capObservabilityOtel.version).toBe("0.1.0");
    expect(capObservabilityOtel.group).toBe("observability");
  });

  it("does NOT auto-install (opt-in only because of runtime cost)", () => {
    expect(capObservabilityOtel.autoInstall).toBe(false);
  });
});
