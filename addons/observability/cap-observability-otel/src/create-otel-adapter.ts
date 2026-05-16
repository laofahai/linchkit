/**
 * Factory that produces an `Observability` bundle backed by the
 * OpenTelemetry SDK.
 *
 * Usage (manual bootstrap path):
 * ```ts
 * import { setObservability } from "@linchkit/core/server";
 * import {
 *   bootstrapNodeSdk,
 *   createOtelAdapter,
 * } from "@linchkit/cap-observability-otel";
 *
 * // Construct + start the NodeSDK BEFORE creating the adapter so
 * // `trace.getTracer(...)` and `metrics.getMeter(...)` resolve to the
 * // real providers (not the no-op stubs).
 * const sdk = bootstrapNodeSdk({ serviceName: "my-service" });
 * sdk.start();
 *
 * setObservability(createOtelAdapter({ serviceName: "my-service" }));
 * ```
 *
 * The adapter only depends on `@opentelemetry/api` at runtime, which
 * uses a global provider registry. That means the adapter does NOT
 * start the SDK on its own — surprise auto-start is bad. Callers opt in
 * via `bootstrapNodeSdk()` (or any other provider registration of
 * their choice).
 *
 * Dependency-injection slots (`tracerProvider` / `meterProvider`) let
 * tests pass a fake OTel `Tracer` / `Meter` without touching the global
 * registry — see `__tests__/create-otel-adapter.test.ts`.
 */

import type { Observability } from "@linchkit/core/server";
import {
  type Meter as OtelMeter,
  type Tracer as OtelTracer,
  metrics as otelMetrics,
  trace as otelTrace,
} from "@opentelemetry/api";
import { OtelMeterAdapter } from "./otel-meter-adapter";
import { OtelTracerAdapter } from "./otel-tracer-adapter";

// ── Options ──────────────────────────────────────────────

/**
 * Resolver returning an OTel `Tracer`. The default resolver calls
 * `trace.getTracer(name, version)` from `@opentelemetry/api`. Tests
 * override this slot to inject a fake.
 */
export type OtelTracerProvider = (name: string, version?: string) => OtelTracer;

/**
 * Resolver returning an OTel `Meter`. The default resolver calls
 * `metrics.getMeter(name, version)` from `@opentelemetry/api`.
 */
export type OtelMeterProvider = (name: string, version?: string) => OtelMeter;

/** Options accepted by `createOtelAdapter`. */
export interface CreateOtelAdapterOptions {
  /**
   * Logical name passed to `trace.getTracer(...)` /
   * `metrics.getMeter(...)`. Convention: use the service name (matches
   * the `service.name` resource attribute set in `bootstrapNodeSdk`).
   *
   * @default "linchkit"
   */
  serviceName?: string;
  /**
   * Optional version string forwarded to `trace.getTracer(name,
   * version)` / `metrics.getMeter(name, version)`. Useful for routing
   * sampling rules per service version.
   */
  serviceVersion?: string;
  /**
   * Override the tracer resolver. Defaults to
   * `(name, version) => trace.getTracer(name, version)`. Pass a fake
   * here in tests.
   */
  tracerProvider?: OtelTracerProvider;
  /**
   * Override the meter resolver. Defaults to
   * `(name, version) => metrics.getMeter(name, version)`. Pass a fake
   * here in tests.
   */
  meterProvider?: OtelMeterProvider;
}

// ── Factory ──────────────────────────────────────────────

const DEFAULT_SERVICE_NAME = "linchkit";

/**
 * Build an `Observability` bundle whose `tracer` + `meter` delegate to
 * the OTel SDK currently registered via `@opentelemetry/api`'s global
 * providers (or via the `tracerProvider` / `meterProvider` overrides).
 *
 * Returns a frozen object so call sites can stash the bundle without
 * worrying about mutation.
 */
export function createOtelAdapter(options: CreateOtelAdapterOptions = {}): Observability {
  const name = options.serviceName ?? DEFAULT_SERVICE_NAME;
  const version = options.serviceVersion;

  const tracerResolver: OtelTracerProvider =
    options.tracerProvider ?? ((n, v) => otelTrace.getTracer(n, v));
  const meterResolver: OtelMeterProvider =
    options.meterProvider ?? ((n, v) => otelMetrics.getMeter(n, v));

  const tracer = new OtelTracerAdapter(tracerResolver(name, version));
  const meter = new OtelMeterAdapter(meterResolver(name, version));

  return Object.freeze({ tracer, meter });
}
