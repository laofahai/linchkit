/**
 * NodeSDK bootstrap helper.
 *
 * Lives in its own module so the OTel adapter factory
 * (`create-otel-adapter.ts`) can be imported in environments that don't
 * have `@opentelemetry/sdk-node` available (e.g. browser bundles that
 * still want the seam types). Callers explicitly opt in by importing
 * this module.
 *
 * Usage:
 * ```ts
 * import { bootstrapNodeSdk } from "@linchkit/cap-observability-otel/bootstrap";
 *
 * const sdk = bootstrapNodeSdk({
 *   serviceName: "linchkit-server",
 *   serviceVersion: "0.2.0",
 *   // endpoint resolves from OTEL_EXPORTER_OTLP_ENDPOINT if omitted
 * });
 * sdk.start();
 *
 * // Graceful shutdown — handle both SIGTERM and SIGINT.
 * for (const signal of ["SIGTERM", "SIGINT"] as const) {
 *   process.on(signal, async () => {
 *     await sdk.shutdown();
 *     process.exit(0);
 *   });
 * }
 * ```
 *
 * No auto-start. Surprise startup means a service silently opens a
 * network connection to whatever `OTEL_EXPORTER_OTLP_ENDPOINT` points
 * at — bad default. The caller's `sdk.start()` is the single explicit
 * opt-in.
 */

import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

// ── Options ──────────────────────────────────────────────

/** Options accepted by `bootstrapNodeSdk`. */
export interface BootstrapNodeSdkOptions {
  /**
   * Service name. Sets the `service.name` resource attribute and is
   * surfaced in every exported span / metric. Should match the value
   * passed to `createOtelAdapter({ serviceName })`.
   *
   * @default "linchkit"
   */
  serviceName?: string;
  /**
   * Optional service version. Sets the `service.version` resource
   * attribute.
   */
  serviceVersion?: string;
  /**
   * Base OTLP/HTTP endpoint (e.g. `http://localhost:4318`). The
   * trace exporter posts to `${endpoint}/v1/traces`, the metric
   * exporter to `${endpoint}/v1/metrics`.
   *
   * Resolution follows the OpenTelemetry specification:
   * 1. Per-signal env var (`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` /
   *    `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`) is used as-is — no path
   *    suffix is appended.
   * 2. Otherwise this `endpoint` option (or the base env var
   *    `OTEL_EXPORTER_OTLP_ENDPOINT`) is treated as the base and the
   *    signal-specific path (`v1/traces` / `v1/metrics`) is appended.
   * 3. If nothing is set the exporters default to
   *    `http://localhost:4318`.
   */
  endpoint?: string;
  /**
   * Optional headers attached to every OTLP/HTTP request (e.g.
   * `{ "authorization": "Bearer ..." }`). Forwarded to both the trace
   * and metric exporters.
   */
  headers?: Record<string, string>;
  /**
   * Metric export interval in milliseconds. Defaults to OTel SDK
   * default (60_000ms / 60s).
   */
  metricExportIntervalMs?: number;
  /**
   * Disable the metric reader entirely. Useful when only tracing is
   * desired or when metrics are exported via a different reader.
   *
   * @default false
   */
  disableMetrics?: boolean;
  /**
   * Disable the trace exporter entirely. Useful when only metrics are
   * desired.
   *
   * @default false
   */
  disableTraces?: boolean;
}

// ── Bootstrap ────────────────────────────────────────────

const DEFAULT_SERVICE_NAME = "linchkit";

/**
 * Build a `NodeSDK` configured with the OTLP/HTTP trace + metric
 * exporters and a `service.name` resource. Caller must invoke
 * `.start()` to register the providers globally.
 *
 * Returns the constructed `NodeSDK` so the caller owns its lifecycle —
 * including graceful shutdown via `await sdk.shutdown()`.
 */
export function bootstrapNodeSdk(options: BootstrapNodeSdkOptions = {}): NodeSDK {
  const serviceName = options.serviceName ?? DEFAULT_SERVICE_NAME;
  const baseEndpoint = options.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const headers = options.headers;

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    ...(options.serviceVersion ? { [ATTR_SERVICE_VERSION]: options.serviceVersion } : {}),
  });

  // Per the OTel spec, per-signal env vars are used verbatim and base
  // endpoints have the signal path appended. When neither is set we
  // pass `undefined` so the exporter falls back to its built-in default
  // (`http://localhost:4318/v1/<signal>`).
  const traceUrl = resolveSignalUrl({
    perSignalEnv: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
    base: baseEndpoint,
    signalPath: "v1/traces",
  });
  const metricUrl = resolveSignalUrl({
    perSignalEnv: process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
    base: baseEndpoint,
    signalPath: "v1/metrics",
  });

  const traceExporter = options.disableTraces
    ? undefined
    : new OTLPTraceExporter({
        ...(traceUrl !== undefined ? { url: traceUrl } : {}),
        ...(headers !== undefined ? { headers } : {}),
      });

  const metricReader = options.disableMetrics
    ? undefined
    : new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          ...(metricUrl !== undefined ? { url: metricUrl } : {}),
          ...(headers !== undefined ? { headers } : {}),
        }),
        ...(options.metricExportIntervalMs !== undefined
          ? { exportIntervalMillis: options.metricExportIntervalMs }
          : {}),
      });

  return new NodeSDK({
    resource,
    ...(traceExporter ? { traceExporter } : {}),
    ...(metricReader ? { metricReader } : {}),
  });
}

// ── Helpers ──────────────────────────────────────────────

/**
 * Resolve the final exporter URL for a single OTLP signal.
 *
 * - If the per-signal env var is set, return it verbatim (OTel spec
 *   says signal-specific endpoints are NOT modified).
 * - Else if a base endpoint is provided, join it with the signal path
 *   using `URL` so we never produce double slashes or drop a configured
 *   path prefix.
 * - Else return `undefined` so the exporter falls back to its built-in
 *   default.
 *
 * Exported for testability.
 */
export function resolveSignalUrl(args: {
  perSignalEnv: string | undefined;
  base: string | undefined;
  signalPath: string;
}): string | undefined {
  const { perSignalEnv, base, signalPath } = args;
  if (perSignalEnv !== undefined && perSignalEnv !== "") {
    return perSignalEnv;
  }
  if (base === undefined || base === "") {
    return undefined;
  }
  // `URL` only honours a relative path correctly when the base ends in
  // "/" — otherwise the last path segment is replaced. Normalise once.
  const normalised = base.endsWith("/") ? base : `${base}/`;
  return new URL(signalPath, normalised).toString();
}
