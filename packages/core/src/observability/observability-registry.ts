/**
 * Observability registry — module-level singleton holding the active
 * `Tracer` + `Meter` pair. This is the seam an OTel adapter (or any
 * other backend) plugs into.
 *
 * Defaults: `NoopTracer` + `NoopMeter`. Calls flow through with zero
 * runtime cost beyond a method call + tiny span object allocation.
 *
 * Usage (instrumented call site):
 * ```ts
 * import { getObservability } from "@linchkit/core/server";
 *
 * const span = getObservability().tracer.startSpan("linchkit.action.submit_request", {
 *   attributes: { "linchkit.tenant_id": tenantId },
 * });
 * try {
 *   // ... work ...
 * } finally {
 *   span.end();
 * }
 * ```
 *
 * Usage (adapter registration, Phase 2):
 * ```ts
 * import { setObservability } from "@linchkit/core/server";
 * import { createOtelAdapter } from "@linchkit/cap-otel";
 *
 * setObservability(createOtelAdapter({ endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT }));
 * ```
 */

import { type Meter, noopMeter } from "./meter";
import { noopTracer, type Tracer } from "./tracer";

// ── Types ────────────────────────────────────────────────

/**
 * Bundle of observability primitives. Always exposes both `tracer`
 * and `meter` — adapters that only ship one MUST still provide the
 * noop for the other (use `noopTracer` / `noopMeter` from this
 * package).
 */
export interface Observability {
  readonly tracer: Tracer;
  readonly meter: Meter;
}

// ── Singleton ────────────────────────────────────────────

const DEFAULT_OBSERVABILITY: Observability = Object.freeze({
  tracer: noopTracer,
  meter: noopMeter,
});

let current: Observability = DEFAULT_OBSERVABILITY;

/**
 * Get the currently registered observability bundle. Returns the
 * frozen `{ tracer: noopTracer, meter: noopMeter }` default until
 * `setObservability` is called.
 *
 * Always returns a non-null bundle — call sites never need to
 * null-check the tracer / meter.
 */
export function getObservability(): Observability {
  return current;
}

/**
 * Register a new observability bundle. Typically called once at
 * startup by a capability (e.g. `cap-otel`). Passing a partial
 * bundle is intentionally NOT supported — be explicit so missing
 * fields surface as type errors rather than silent noops.
 *
 * Returns the previous bundle so callers can compose / restore in
 * tests.
 */
export function setObservability(next: Observability): Observability {
  const prev = current;
  current = next;
  return prev;
}

/**
 * Reset the registry to the noop default. Primarily a test helper so
 * one test's `setObservability` call cannot leak into the next.
 */
export function resetObservability(): Observability {
  return setObservability(DEFAULT_OBSERVABILITY);
}
