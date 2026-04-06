/**
 * Alert Engine — Metric-based alerting rules.
 *
 * System-level alerts that evaluate conditions against collected metrics
 * and notify configured channels when thresholds are breached.
 *
 * Alert rules are themselves system rules (spec 28 §2.3), evaluated
 * periodically or on-demand against the MetricsCollector.
 */

import type { AlertDispatcher, FiredAlert } from "./alert-channels";
import type { InMemoryMetricsCollector } from "./metrics";

// ── Types ────────────────────────────────────────────────

export type AlertSeverity = "info" | "warning" | "critical";

export type AlertOperator = "gt" | "gte" | "lt" | "lte" | "eq" | "neq";

export interface AlertCondition {
  /** Metric name to evaluate (counter or gauge) */
  metric: string;
  /** Comparison operator */
  operator: AlertOperator;
  /** Threshold value */
  value: number;
  /** Time window for rate-based metrics (e.g. "5m", "1h"). Reserved for future use. */
  window?: string;
  /** Tags to filter the metric (optional) */
  tags?: Record<string, string>;
  /** For histogram metrics, which percentile to use (e.g. "p95") */
  percentile?: "p50" | "p90" | "p95" | "p99" | "mean" | "max";
}

export interface AlertEffect {
  /** Who to notify */
  notify: string[];
  /** Notification channel */
  channel?: string;
  /** Alert severity (default: "warning") */
  severity?: AlertSeverity;
  /** Custom message template */
  message?: string;
}

export interface SystemAlertDefinition {
  /** Unique alert rule name */
  name: string;
  /** Human-readable label */
  label?: string;
  /** Condition that triggers the alert */
  condition: AlertCondition;
  /** Effect when triggered */
  effect: AlertEffect;
  /** Whether the alert is enabled (default: true) */
  enabled?: boolean;
}

export interface AlertEvaluationResult {
  /** Alert rule name */
  alert: string;
  /** Whether the condition was met */
  triggered: boolean;
  /** The actual metric value that was evaluated */
  actualValue: number | null;
  /** The threshold value */
  threshold: number;
  /** Severity of the alert (only meaningful when triggered) */
  severity: AlertSeverity;
  /** Timestamp of evaluation */
  timestamp: string;
}

/** Callback invoked when an alert triggers */
export type AlertHandler = (
  result: AlertEvaluationResult,
  definition: SystemAlertDefinition,
) => void;

// ── defineSystemAlert ───────────────────────────────────

/** Helper to create a typed SystemAlertDefinition */
export function defineSystemAlert(def: SystemAlertDefinition): SystemAlertDefinition {
  return { ...def, enabled: def.enabled ?? true };
}

// ── AlertEngine ─────────────────────────────────────────

export interface AlertEngineOptions {
  /** Metrics collector to evaluate against */
  metrics: InMemoryMetricsCollector;
  /** Handler called when an alert triggers */
  onAlert?: AlertHandler;
  /** Optional dispatcher for delivering alerts through channels */
  dispatcher?: AlertDispatcher;
}

export class AlertEngine {
  private alerts = new Map<string, SystemAlertDefinition>();
  private readonly metrics: InMemoryMetricsCollector;
  private readonly onAlert: AlertHandler;
  private dispatcher: AlertDispatcher | undefined;
  /** Track firing state to avoid duplicate notifications */
  private firingState = new Map<string, boolean>();

  constructor(options: AlertEngineOptions) {
    this.metrics = options.metrics;
    this.onAlert = options.onAlert ?? (() => {});
    this.dispatcher = options.dispatcher;
  }

  /** Set or replace the alert dispatcher */
  setDispatcher(dispatcher: AlertDispatcher): void {
    this.dispatcher = dispatcher;
  }

  /** Register an alert definition */
  register(alert: SystemAlertDefinition): void {
    this.alerts.set(alert.name, { ...alert, enabled: alert.enabled ?? true });
  }

  /** Unregister an alert definition */
  unregister(name: string): void {
    this.alerts.delete(name);
    this.firingState.delete(name);
  }

  /** List all registered alert definitions */
  list(): SystemAlertDefinition[] {
    return Array.from(this.alerts.values());
  }

  /**
   * Evaluate all registered alerts against current metrics.
   * Returns results for every enabled alert rule.
   * Calls onAlert for newly triggered alerts (transition from not-firing to firing).
   */
  evaluateAll(): AlertEvaluationResult[] {
    const results: AlertEvaluationResult[] = [];

    for (const alert of this.alerts.values()) {
      if (alert.enabled === false) continue;
      const result = this.evaluateOne(alert);
      results.push(result);

      // Detect transition: fire handler only on rising edge
      const wasFiring = this.firingState.get(alert.name) ?? false;
      if (result.triggered && !wasFiring) {
        this.onAlert(result, alert);
        // Dispatch through channels if dispatcher is configured
        if (this.dispatcher) {
          const fired: FiredAlert = { result, definition: alert };
          this.dispatcher.dispatch(fired).catch(() => {
            // Dispatcher handles its own error logging per-channel
          });
        }
      }
      this.firingState.set(alert.name, result.triggered);
    }

    return results;
  }

  /** Evaluate a single alert rule against current metrics */
  private evaluateOne(alert: SystemAlertDefinition): AlertEvaluationResult {
    const { condition, effect } = alert;
    const actualValue = this.resolveMetricValue(condition);

    const triggered =
      actualValue !== null ? compareValue(actualValue, condition.operator, condition.value) : false;

    return {
      alert: alert.name,
      triggered,
      actualValue,
      threshold: condition.value,
      severity: effect.severity ?? "warning",
      timestamp: new Date().toISOString(),
    };
  }

  /** Resolve the current value of a metric based on the condition config */
  private resolveMetricValue(condition: AlertCondition): number | null {
    // Check histogram percentiles first
    if (condition.percentile) {
      const pctls = this.metrics.getPercentiles(condition.metric);
      if (!pctls) return null;
      return pctls[condition.percentile] ?? null;
    }

    // Try counter
    const counterVal = this.metrics.getCounter(condition.metric, condition.tags ?? {});
    if (counterVal > 0) return counterVal;

    // Try gauge
    const gaugeVal = this.metrics.getGauge(condition.metric, condition.tags ?? {});
    if (gaugeVal !== undefined) return gaugeVal;

    // Try histogram count (if no percentile specified, use count)
    const histValues = this.metrics.getHistogramValues(condition.metric);
    if (histValues.length > 0) return histValues.length;

    return null;
  }
}

// ── Comparison helper ──────────────────────────────────

function compareValue(actual: number, operator: AlertOperator, threshold: number): boolean {
  switch (operator) {
    case "gt":
      return actual > threshold;
    case "gte":
      return actual >= threshold;
    case "lt":
      return actual < threshold;
    case "lte":
      return actual <= threshold;
    case "eq":
      return actual === threshold;
    case "neq":
      return actual !== threshold;
  }
}
