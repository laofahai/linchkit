/**
 * Tests for OtelTracerAdapter / OtelSpanAdapter.
 *
 * Uses hand-rolled fakes (not bun mock.module) because `mock.module`
 * leaks across files in the project's shared bun:test process.
 */

import { describe, expect, it } from "bun:test";
import {
  type Attributes as OtelAttributes,
  type Exception as OtelException,
  type Link as OtelLink,
  type Span as OtelSpan,
  type SpanContext as OtelSpanContext,
  SpanKind as OtelSpanKind,
  type SpanOptions as OtelSpanOptions,
  type SpanStatus as OtelSpanStatus,
  SpanStatusCode as OtelSpanStatusCode,
  type Tracer as OtelTracer,
  type TimeInput,
} from "@opentelemetry/api";
import { OtelSpanAdapter, OtelTracerAdapter } from "../src/otel-tracer-adapter";

// ── Fake OTel span ───────────────────────────────────────

interface RecordedException {
  exception: OtelException;
  time?: TimeInput;
}

class FakeOtelSpan implements OtelSpan {
  attributes: OtelAttributes = {};
  status: OtelSpanStatus = { code: OtelSpanStatusCode.UNSET };
  exceptions: RecordedException[] = [];
  ended = false;
  endTime: TimeInput | undefined;

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
  addLink(_link: OtelLink): this {
    return this;
  }
  addLinks(_links: OtelLink[]): this {
    return this;
  }
  setStatus(status: OtelSpanStatus): this {
    this.status = status;
    return this;
  }
  updateName(): this {
    return this;
  }
  end(endTime?: TimeInput): void {
    this.ended = true;
    this.endTime = endTime;
  }
  isRecording(): boolean {
    return !this.ended;
  }
  recordException(exception: OtelException, time?: TimeInput): void {
    this.exceptions.push({ exception, time });
  }
  spanContext(): OtelSpanContext {
    return {
      traceId: "00000000000000000000000000000000",
      spanId: "0000000000000000",
      traceFlags: 0,
    };
  }
}

// ── Fake OTel tracer ─────────────────────────────────────

class FakeOtelTracer implements OtelTracer {
  lastName: string | undefined;
  lastOptions: OtelSpanOptions | undefined;
  span = new FakeOtelSpan();

  startSpan(name: string, options?: OtelSpanOptions): OtelSpan {
    this.lastName = name;
    this.lastOptions = options;
    return this.span;
  }
  // The full Tracer interface also requires startActiveSpan; the
  // adapter never calls it so we throw to surface accidental usage.
  startActiveSpan(): never {
    throw new Error("startActiveSpan is not used by OtelTracerAdapter");
  }
}

// ── Tests ────────────────────────────────────────────────

describe("OtelTracerAdapter", () => {
  it("forwards span name and translates SpanKind", () => {
    const tracer = new FakeOtelTracer();
    const adapter = new OtelTracerAdapter(tracer);

    adapter.startSpan("linchkit.action.submit_request", { kind: "server" });

    expect(tracer.lastName).toBe("linchkit.action.submit_request");
    expect(tracer.lastOptions?.kind).toBe(OtelSpanKind.SERVER);
  });

  it("defaults span kind to INTERNAL when not provided", () => {
    const tracer = new FakeOtelTracer();
    const adapter = new OtelTracerAdapter(tracer);

    adapter.startSpan("noop");

    expect(tracer.lastOptions?.kind).toBe(OtelSpanKind.INTERNAL);
  });

  it("forwards initial attributes and startTime", () => {
    const tracer = new FakeOtelTracer();
    const adapter = new OtelTracerAdapter(tracer);

    adapter.startSpan("with-attrs", {
      attributes: { "linchkit.tenant_id": "t-1", "linchkit.size": 42 },
      startTime: 123,
    });

    expect(tracer.lastOptions?.attributes).toEqual({
      "linchkit.tenant_id": "t-1",
      "linchkit.size": 42,
    });
    expect(tracer.lastOptions?.startTime).toBe(123);
  });

  it("translates every SpanKind value", () => {
    const tracer = new FakeOtelTracer();
    const adapter = new OtelTracerAdapter(tracer);

    const mappings: Array<[Parameters<typeof adapter.startSpan>[1] & object, OtelSpanKind]> = [
      [{ kind: "internal" }, OtelSpanKind.INTERNAL],
      [{ kind: "server" }, OtelSpanKind.SERVER],
      [{ kind: "client" }, OtelSpanKind.CLIENT],
      [{ kind: "producer" }, OtelSpanKind.PRODUCER],
      [{ kind: "consumer" }, OtelSpanKind.CONSUMER],
    ];

    for (const [opts, expected] of mappings) {
      adapter.startSpan("k", opts);
      expect(tracer.lastOptions?.kind).toBe(expected);
    }
  });
});

describe("OtelSpanAdapter", () => {
  it("forwards setAttribute to the underlying span", () => {
    const inner = new FakeOtelSpan();
    const span = new OtelSpanAdapter(inner);

    const result = span.setAttribute("linchkit.action", "submit_request");

    expect(result).toBe(span);
    expect(inner.attributes["linchkit.action"]).toBe("submit_request");
  });

  it("forwards setAttributes (bulk)", () => {
    const inner = new FakeOtelSpan();
    const span = new OtelSpanAdapter(inner);

    span.setAttributes({ a: 1, b: "two", c: true });

    expect(inner.attributes).toEqual({ a: 1, b: "two", c: true });
  });

  it("forwards recordException for Error instances", () => {
    const inner = new FakeOtelSpan();
    const span = new OtelSpanAdapter(inner);
    const err = new Error("boom");

    span.recordException(err);

    expect(inner.exceptions).toHaveLength(1);
    expect(inner.exceptions[0]?.exception).toBe(err);
  });

  it("forwards recordException for string messages", () => {
    const inner = new FakeOtelSpan();
    const span = new OtelSpanAdapter(inner);

    span.recordException("plain message");

    expect(inner.exceptions[0]?.exception).toBe("plain message");
  });

  it("translates setStatus codes", () => {
    const inner = new FakeOtelSpan();
    const span = new OtelSpanAdapter(inner);

    span.setStatus({ code: "ok" });
    expect(inner.status.code).toBe(OtelSpanStatusCode.OK);

    span.setStatus({ code: "error", message: "failed" });
    expect(inner.status.code).toBe(OtelSpanStatusCode.ERROR);
    expect(inner.status.message).toBe("failed");

    span.setStatus({ code: "unset" });
    expect(inner.status.code).toBe(OtelSpanStatusCode.UNSET);
  });

  it("ends the underlying span and reports isRecording=false", () => {
    const inner = new FakeOtelSpan();
    const span = new OtelSpanAdapter(inner);

    expect(span.isRecording()).toBe(true);

    span.end(999);

    expect(inner.ended).toBe(true);
    expect(inner.endTime).toBe(999);
    expect(span.isRecording()).toBe(false);
  });

  it("end() is idempotent — second call is a no-op", () => {
    const inner = new FakeOtelSpan();
    const span = new OtelSpanAdapter(inner);

    span.end(100);
    inner.endTime = undefined; // overwrite to detect second call

    span.end(200);

    expect(inner.endTime).toBeUndefined();
  });
});
