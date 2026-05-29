/**
 * Observability — alert/meter/metrics/tracer types + Noop classes (browser-safe).
 * Runtime sinks (alert engine, structured logger, console logger,
 * execution logger) live in ../server/observability.ts.
 */

export type {
  AIGeneration,
  AITrace,
  AITraceContext,
  AITraceMessage,
  AITraceOrigin,
  AITraceQueryOptions,
  AITraceSamplingConfig,
  AITraceSink,
  AITraceStatus,
  EndTraceParams,
  RecordGenerationParams,
  RedactionMode,
  RedactionPolicy,
  StartTraceParams,
} from "../../observability/ai-trace";
export type {
  AlertCondition,
  AlertEffect,
  AlertEvaluationResult,
  AlertOperator,
  AlertSeverity,
  SystemAlertDefinition,
} from "../../observability/alert-engine";
export type {
  Counter,
  Histogram,
  InstrumentOptions,
  Meter,
  MetricAttributes,
  MetricAttributeValue,
} from "../../observability/meter";
export { NoopMeter, noopMeter } from "../../observability/meter";
export type {
  MetricSnapshot,
  MetricsCollector,
  MetricsSummary,
} from "../../observability/metrics";
export type { Observability } from "../../observability/observability-registry";
export {
  getObservability,
  resetObservability,
  setObservability,
} from "../../observability/observability-registry";
export type {
  LogLevel,
  LogSink,
  StructuredLogEntry,
  StructuredLoggerOptions,
} from "../../observability/structured-logger";
export type { TraceState } from "../../observability/trace-context";
export type {
  Span,
  SpanAttributes,
  SpanAttributeValue,
  SpanKind,
  SpanStatus,
  SpanStatusCode,
  StartSpanOptions,
  Tracer,
} from "../../observability/tracer";
export { NoopTracer, noopTracer } from "../../observability/tracer";
