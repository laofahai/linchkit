/**
 * Observability runtime — alert engine, console logger, structured logger,
 * execution logger, metrics, trace context, tracer (server-only).
 */

export {
  type AlertCondition,
  type AlertEffect,
  AlertEngine,
  type AlertEngineOptions,
  type AlertEvaluationResult,
  type AlertHandler,
  type AlertOperator,
  type AlertSeverity,
  defineSystemAlert,
  type SystemAlertDefinition,
} from "../../observability/alert-engine";
export { consoleLogger } from "../../observability/console-logger";
export { InMemoryExecutionLogger } from "../../observability/execution-logger";
export type {
  Counter,
  Histogram,
  InstrumentOptions,
  Meter,
  MetricAttributes,
  MetricAttributeValue,
} from "../../observability/meter";
export { NoopMeter, noopMeter } from "../../observability/meter";
export {
  InMemoryMetricsCollector,
  type MetricSnapshot,
  type MetricsCollector,
  type MetricsSummary,
  noopMetricsCollector,
} from "../../observability/metrics";
export type { Observability } from "../../observability/observability-registry";
export {
  getObservability,
  resetObservability,
  setObservability,
} from "../../observability/observability-registry";
export {
  createStructuredLogger,
  createTestLogSink,
  type LogLevel,
  type LogSink,
  type StructuredLogEntry,
  type StructuredLoggerOptions,
} from "../../observability/structured-logger";
export {
  getCurrentTrace,
  getTraceDepth,
  type TraceState,
  withTrace,
} from "../../observability/trace-context";
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
