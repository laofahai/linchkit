/**
 * @linchkit/cap-observability-otel — public API
 *
 * Adapter that wires LinchKit's observability seam
 * (`packages/core/src/observability/*`) to the OpenTelemetry SDK.
 *
 * Two entry points:
 * 1. `createOtelAdapter()` — returns an `Observability` bundle to pass
 *    to `setObservability(...)`.
 * 2. `bootstrapNodeSdk()` — constructs a `NodeSDK` with OTLP/HTTP
 *    trace + metric exporters; caller owns `.start()` and
 *    `.shutdown()`.
 *
 * Spec 28 M3 / issue #130.
 */

export { capObservabilityOtel } from "./capability";
export {
  type CreateOtelAdapterOptions,
  createOtelAdapter,
  type OtelMeterProvider,
  type OtelTracerProvider,
} from "./create-otel-adapter";
export {
  OtelCounterAdapter,
  OtelHistogramAdapter,
  OtelMeterAdapter,
} from "./otel-meter-adapter";
export { OtelSpanAdapter, OtelTracerAdapter } from "./otel-tracer-adapter";
export {
  type BootstrapNodeSdkOptions,
  bootstrapNodeSdk,
} from "./sdk-bootstrap";
