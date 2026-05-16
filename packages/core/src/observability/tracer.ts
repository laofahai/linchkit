/**
 * Tracer — OTel-compatible tracing seam (Spec 28 M3 / issue #130).
 *
 * Provides a minimal `Tracer` / `Span` interface that mirrors the shape of
 * `@opentelemetry/api` without taking a dependency on it. A future
 * `cap-otel` capability can drop in a real OTel adapter that implements
 * this interface; until then `NoopTracer` is wired in via the
 * observability registry so call sites can sprinkle `startSpan(...)` /
 * `span.end()` without any runtime cost.
 *
 * Phase 1 (this file): types + no-op implementation only. No exporter,
 * no protobuf, no transport. The named seam exists so call sites
 * (CommandLayer, ActionEngine, EventHandlers, Flow steps) can be
 * instrumented incrementally and the OTel adapter can ship later
 * without rewriting any call sites.
 */

// ── Span attribute values ────────────────────────────────

/**
 * Valid attribute value types — mirrors OTel's
 * `AttributeValue` union to keep the seam swap-in compatible. Strings,
 * numbers, booleans, and homogeneous arrays of those are allowed.
 */
export type SpanAttributeValue =
  | string
  | number
  | boolean
  | readonly string[]
  | readonly number[]
  | readonly boolean[];

/** Attribute bag attached to a span (OTel `Attributes` shape). */
export type SpanAttributes = Record<string, SpanAttributeValue>;

// ── Span ─────────────────────────────────────────────────

/** Status code reported on a span when it ends. */
export type SpanStatusCode = "unset" | "ok" | "error";

/** Status payload reported on a span when it ends. */
export interface SpanStatus {
  code: SpanStatusCode;
  /** Human-readable status message (optional, recommended for `error`). */
  message?: string;
}

/**
 * A live span. Mirrors the operations we expect to use from
 * `@opentelemetry/api`'s `Span` type without pulling the dependency in.
 *
 * Lifecycle: created by `Tracer.startSpan()`, mutated via
 * `setAttribute(s)` / `recordException` / `setStatus`, finalized via
 * `end()`. After `end()` no further mutations are permitted (no-op in
 * the noop impl; OTel adapter will warn).
 */
export interface Span {
  /** Set a single attribute. */
  setAttribute(key: string, value: SpanAttributeValue): this;
  /** Bulk-set attributes (overwrites existing keys). */
  setAttributes(attrs: SpanAttributes): this;
  /** Record an exception on the span without ending it. */
  recordException(error: Error | string): this;
  /** Set the span status; an unset error code is recommended for failures. */
  setStatus(status: SpanStatus): this;
  /** Finalize the span. Must be called exactly once per span. */
  end(endTime?: number): void;
  /** Returns true after `end()` has been called. */
  isRecording(): boolean;
}

// ── Tracer ───────────────────────────────────────────────

/** SpanKind — same five values as OTel. */
export type SpanKind = "internal" | "server" | "client" | "producer" | "consumer";

/** Options accepted by `Tracer.startSpan`. */
export interface StartSpanOptions {
  /** Span kind — defaults to "internal" for in-process work. */
  kind?: SpanKind;
  /** Initial attribute bag. */
  attributes?: SpanAttributes;
  /** Explicit start time in epoch milliseconds (defaults to now). */
  startTime?: number;
}

/**
 * Tracer — creates spans. Mirrors the subset of `@opentelemetry/api`'s
 * `Tracer` we plan to use.
 */
export interface Tracer {
  /**
   * Start a new span. The returned span is "current" only for the
   * caller's scope — Phase 1 does NOT implement context propagation
   * (that comes with the OTel adapter). Use the returned `Span` handle
   * directly and call `end()` when done.
   */
  startSpan(name: string, options?: StartSpanOptions): Span;
}

// ── Noop implementation ──────────────────────────────────

/**
 * Default no-op span. All mutators return `this` for chainability and
 * `end()` / `isRecording()` are inert. Allocates one tiny object per
 * `startSpan()` — acceptable for the seam since callers typically pair
 * it with a `try { ... } finally { span.end() }` pattern.
 */
class NoopSpan implements Span {
  private ended = false;

  setAttribute(_key: string, _value: SpanAttributeValue): this {
    return this;
  }
  setAttributes(_attrs: SpanAttributes): this {
    return this;
  }
  recordException(_error: Error | string): this {
    return this;
  }
  setStatus(_status: SpanStatus): this {
    return this;
  }
  end(_endTime?: number): void {
    this.ended = true;
  }
  isRecording(): boolean {
    return !this.ended;
  }
}

/**
 * Default no-op tracer — returns a fresh `NoopSpan` for every call.
 * Used as the registry default; replaced via `setObservability(...)`
 * once an OTel adapter is wired in.
 */
export class NoopTracer implements Tracer {
  startSpan(_name: string, _options?: StartSpanOptions): Span {
    return new NoopSpan();
  }
}

/** Singleton instance to avoid per-call allocation of the tracer itself. */
export const noopTracer: Tracer = new NoopTracer();
