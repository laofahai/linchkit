/**
 * OpenTelemetry Tracer adapter.
 *
 * Wraps `@opentelemetry/api`'s `Tracer` / `Span` so it satisfies LinchKit
 * core's `Tracer` / `Span` interface from
 * `packages/core/src/observability/tracer.ts`. Call sites in core (and
 * other capabilities) talk to the LinchKit interface and stay decoupled
 * from the OTel SDK.
 *
 * Field-mapping notes:
 * - `SpanKind` is a string union in core, an enum in OTel. We translate
 *   on the way in (`mapSpanKind`).
 * - `SpanStatusCode` is `"unset" | "ok" | "error"` in core; OTel's
 *   `SpanStatusCode` is an enum with the same three semantics
 *   (`UNSET = 0`, `OK = 1`, `ERROR = 2`).
 * - `recordException` accepts `Error | string` in core. OTel accepts the
 *   same plus an `Exception` shape; we forward the value as-is so the
 *   underlying SDK can normalize.
 * - `startTime` in core is "epoch milliseconds"; OTel accepts the same
 *   numeric form on `startSpan`.
 *
 * Phase 1 intentionally does NOT propagate OTel `Context` — call sites
 * use the returned `Span` handle directly with `try { ... } finally
 * { span.end() }`, matching the seam contract in the core comments.
 */

import type {
  Span,
  SpanAttributes,
  SpanAttributeValue,
  SpanKind,
  SpanStatus,
  StartSpanOptions,
  Tracer,
} from "@linchkit/core/server";
import {
  type Attributes as OtelAttributes,
  type AttributeValue as OtelAttributeValue,
  type Span as OtelSpan,
  SpanKind as OtelSpanKind,
  SpanStatusCode as OtelSpanStatusCode,
  type Tracer as OtelTracer,
} from "@opentelemetry/api";

// ── Span kind translation ────────────────────────────────

const SPAN_KIND_MAP: Readonly<Record<SpanKind, OtelSpanKind>> = Object.freeze({
  internal: OtelSpanKind.INTERNAL,
  server: OtelSpanKind.SERVER,
  client: OtelSpanKind.CLIENT,
  producer: OtelSpanKind.PRODUCER,
  consumer: OtelSpanKind.CONSUMER,
});

function mapSpanKind(kind: SpanKind | undefined): OtelSpanKind {
  return kind ? SPAN_KIND_MAP[kind] : OtelSpanKind.INTERNAL;
}

// ── Status code translation ──────────────────────────────

function mapStatusCode(code: SpanStatus["code"]): OtelSpanStatusCode {
  switch (code) {
    case "ok":
      return OtelSpanStatusCode.OK;
    case "error":
      return OtelSpanStatusCode.ERROR;
    default:
      return OtelSpanStatusCode.UNSET;
  }
}

// ── Span wrapper ─────────────────────────────────────────

/**
 * Wraps an OTel `Span` so it satisfies LinchKit's `Span` interface.
 * Tracks an `ended` flag locally so `isRecording()` matches the noop
 * implementation's semantics — once `end()` has been called, the span
 * is no longer recording from the caller's perspective.
 */
export class OtelSpanAdapter implements Span {
  private ended = false;

  constructor(private readonly inner: OtelSpan) {}

  setAttribute(key: string, value: SpanAttributeValue): this {
    // OTel's setAttribute accepts the same union (string / number /
    // boolean / homogeneous array) so forwarding is safe.
    this.inner.setAttribute(key, value as OtelAttributeValue);
    return this;
  }

  setAttributes(attrs: SpanAttributes): this {
    this.inner.setAttributes(attrs as OtelAttributes);
    return this;
  }

  recordException(error: Error | string): this {
    this.inner.recordException(error);
    return this;
  }

  setStatus(status: SpanStatus): this {
    this.inner.setStatus({
      code: mapStatusCode(status.code),
      message: status.message,
    });
    return this;
  }

  end(endTime?: number): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    this.inner.end(endTime);
  }

  isRecording(): boolean {
    // Core's contract: returns true until end() has been called.
    return !this.ended;
  }
}

// ── Tracer wrapper ───────────────────────────────────────

/**
 * Wraps an OTel `Tracer` so it satisfies LinchKit's `Tracer` interface.
 * `tracerName` / `tracerVersion` are forwarded to
 * `trace.getTracer(name, version)` by the caller when the adapter is
 * constructed.
 */
export class OtelTracerAdapter implements Tracer {
  constructor(private readonly inner: OtelTracer) {}

  startSpan(name: string, options?: StartSpanOptions): Span {
    const otelSpan = this.inner.startSpan(name, {
      kind: mapSpanKind(options?.kind),
      attributes: options?.attributes as OtelAttributes | undefined,
      startTime: options?.startTime,
    });
    return new OtelSpanAdapter(otelSpan);
  }
}
