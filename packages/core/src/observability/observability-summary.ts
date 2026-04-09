/**
 * Observability Summary — Aggregated view of system metrics and health.
 *
 * Combines metric summaries from the MetricsCollector with health check
 * results from the HealthCheckRegistry into a single structured snapshot
 * suitable for status endpoints and dashboards.
 */

import type { AggregatedHealthStatus, HealthCheckRegistry } from "../deployment/health-check";
import type { InMemoryMetricsCollector, MetricsSummary } from "./metrics";

// ── Types ────────────────────────────────────────────────

export interface ObservabilitySummary {
  /** Timestamp of when the summary was generated (ISO 8601) */
  timestamp: string;
  /** Aggregated metric summaries (counters, gauges, histograms with percentiles) */
  metrics: MetricsSummary;
  /** Health check results (only present if healthChecks provided) */
  health?: AggregatedHealthStatus;
}

export interface BuildObservabilitySummaryOptions {
  /** Metrics collector to extract summaries from */
  metrics: InMemoryMetricsCollector;
  /** Optional health check registry for liveness/readiness status */
  healthChecks?: HealthCheckRegistry;
}

// ── Builder ─────────────────────────────────────────────

/**
 * Build a structured observability summary combining metrics and health checks.
 *
 * Usage:
 * ```ts
 * const summary = await buildObservabilitySummary({
 *   metrics: metricsCollector,
 *   healthChecks: healthRegistry,
 * });
 * ```
 */
export async function buildObservabilitySummary(
  opts: BuildObservabilitySummaryOptions,
): Promise<ObservabilitySummary> {
  const metricsSummary = opts.metrics.getSummary();

  const summary: ObservabilitySummary = {
    timestamp: new Date().toISOString(),
    metrics: metricsSummary,
  };

  if (opts.healthChecks) {
    summary.health = await opts.healthChecks.runAll();
  }

  return summary;
}
