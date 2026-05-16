/**
 * NoopTracer lifecycle tests (Spec 28 M3 / issue #130 Phase 1).
 *
 * Verifies the seam's safety contract: every method on a noop span
 * is chainable, end() is idempotent in effect, and isRecording() flips
 * after end().
 */

import { describe, expect, it } from "bun:test";
import { NoopTracer, noopTracer } from "../tracer";

describe("NoopTracer", () => {
  it("returns a recording span until end() is called", () => {
    const span = noopTracer.startSpan("op");
    expect(span.isRecording()).toBe(true);
    span.end();
    expect(span.isRecording()).toBe(false);
  });

  it("mutator methods are chainable", () => {
    const span = noopTracer.startSpan("op");
    const chained = span
      .setAttribute("a", 1)
      .setAttributes({ b: "x", c: true })
      .recordException(new Error("nope"))
      .recordException("string-error")
      .setStatus({ code: "ok" });
    expect(chained).toBe(span);
    span.end();
  });

  it("end() can be called with an explicit endTime without throwing", () => {
    const span = noopTracer.startSpan("op", { kind: "server", startTime: 1 });
    expect(() => span.end(2)).not.toThrow();
  });

  it("returns a fresh span per call (no shared mutable state)", () => {
    const a = noopTracer.startSpan("a");
    const b = noopTracer.startSpan("b");
    expect(a).not.toBe(b);
    a.end();
    expect(b.isRecording()).toBe(true);
    b.end();
  });

  it("a freshly constructed NoopTracer behaves identically to the singleton", () => {
    const local = new NoopTracer();
    const span = local.startSpan("local");
    expect(span.isRecording()).toBe(true);
    span.end();
    expect(span.isRecording()).toBe(false);
  });
});
