/**
 * observability-registry tests (Spec 28 M3 / issue #130 Phase 1).
 *
 * Covers the seam contract: noop default, swap-in via
 * `setObservability`, reset, and that the default noop is safe to
 * exercise (no throws, no allocations beyond a fresh span object).
 */

import { afterEach, describe, expect, it } from "bun:test";
import { type Counter, type Histogram, type Meter, noopMeter } from "../meter";
import {
  getObservability,
  type Observability,
  resetObservability,
  setObservability,
} from "../observability-registry";
import { NoopTracer, noopTracer, type Span, type StartSpanOptions, type Tracer } from "../tracer";

describe("observability-registry", () => {
  afterEach(() => {
    // Always restore the noop default so cross-test leakage is impossible.
    resetObservability();
  });

  it("returns the noop default before anything is registered", () => {
    const obs = getObservability();
    expect(obs.tracer).toBe(noopTracer);
    expect(obs.meter).toBe(noopMeter);
  });

  it("calling noop tracer + meter methods does not throw", () => {
    const obs = getObservability();
    const span = obs.tracer.startSpan("noop.span");
    expect(() => {
      span.setAttribute("k", "v");
      span.setAttributes({ a: 1, b: true });
      span.recordException(new Error("boom"));
      span.setStatus({ code: "error", message: "boom" });
      span.end();
    }).not.toThrow();

    const counter = obs.meter.createCounter("noop.counter");
    const hist = obs.meter.createHistogram("noop.hist");
    expect(() => {
      counter.add(1, { k: "v" });
      hist.record(42);
    }).not.toThrow();
  });

  it("setObservability swaps in a fake tracer + meter and returns the previous bundle", () => {
    const spanCalls: Array<{ name: string; options?: StartSpanOptions }> = [];
    const fakeSpan: Span = {
      setAttribute: () => fakeSpan,
      setAttributes: () => fakeSpan,
      recordException: () => fakeSpan,
      setStatus: () => fakeSpan,
      end: () => {},
      isRecording: () => true,
    };
    const fakeTracer: Tracer = {
      startSpan(name, options) {
        spanCalls.push({ name, options });
        return fakeSpan;
      },
    };
    const counterAdds: Array<{ name: string; value: number }> = [];
    const histRecords: Array<{ name: string; value: number }> = [];
    const fakeMeter: Meter = {
      createCounter(name): Counter {
        return {
          add(value) {
            counterAdds.push({ name, value });
          },
        };
      },
      createHistogram(name): Histogram {
        return {
          record(value) {
            histRecords.push({ name, value });
          },
        };
      },
    };

    const fake: Observability = { tracer: fakeTracer, meter: fakeMeter };
    const prev = setObservability(fake);
    expect(prev.tracer).toBe(noopTracer);
    expect(prev.meter).toBe(noopMeter);

    const obs = getObservability();
    expect(obs).toBe(fake);

    obs.tracer.startSpan("linchkit.command.dispatch", { attributes: { ok: true } });
    obs.meter.createCounter("c").add(3);
    obs.meter.createHistogram("h").record(7);

    expect(spanCalls).toEqual([
      { name: "linchkit.command.dispatch", options: { attributes: { ok: true } } },
    ]);
    expect(counterAdds).toEqual([{ name: "c", value: 3 }]);
    expect(histRecords).toEqual([{ name: "h", value: 7 }]);
  });

  it("resetObservability restores the noop default", () => {
    const fake: Observability = {
      tracer: new NoopTracer(),
      meter: noopMeter,
    };
    setObservability(fake);
    expect(getObservability()).toBe(fake);

    resetObservability();
    const obs = getObservability();
    expect(obs.tracer).toBe(noopTracer);
    expect(obs.meter).toBe(noopMeter);
  });
});
