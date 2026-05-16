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
 * // Graceful shutdown
 * process.on("SIGTERM", async () => { await sdk.shutdown(); });
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
   * exporter to `${endpoint}/v1/metrics` — the OTel SDK appends those
   * paths automatically when only the base is provided via env.
   *
   * Falls back to the `OTEL_EXPORTER_OTLP_ENDPOINT` env var; if that
   * is also unset the exporters default to `http://localhost:4318`.
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
  const endpoint = options.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const headers = options.headers;

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    ...(options.serviceVersion ? { [ATTR_SERVICE_VERSION]: options.serviceVersion } : {}),
  });

  // OTLP exporters resolve their endpoint from `url` if provided; when
  // `url` is undefined they fall back to env vars themselves, so it is
  // safe to pass `undefined` here.
  const traceExporter = options.disableTraces
    ? undefined
    : new OTLPTraceExporter({
        url: endpoint ? `${trimSlash(endpoint)}/v1/traces` : undefined,
        headers,
      });

  const metricReader = options.disableMetrics
    ? undefined
    : new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          url: endpoint ? `${trimSlash(endpoint)}/v1/metrics` : undefined,
          headers,
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

function trimSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
