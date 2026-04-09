/**
 * System Alerts — Pre-defined alert rule templates for common operational conditions.
 *
 * Registers built-in alert rules against the AlertEngine using metrics
 * from the InMemoryMetricsCollector. These cover common failure modes
 * like high error rates.
 */

import type { AlertEngine } from "./alert-engine";
import { defineSystemAlert } from "./alert-engine";
import type { InMemoryMetricsCollector } from "./metrics";

// ── Pre-defined alert templates ─────────────────────────

/**
 * High error rate alert — triggers when action.errors counter exceeds
 * 10% of total action.executions.
 *
 * Since the AlertEngine evaluates raw counter values (not ratios),
 * this function registers a periodic evaluation callback that computes
 * the error rate and updates a gauge that the alert engine can check.
 */
const HIGH_ERROR_RATE_ALERT = defineSystemAlert({
  name: "high_error_rate",
  label: "High Action Error Rate",
  condition: {
    metric: "action.error_rate_pct",
    operator: "gt",
    value: 10,
  },
  effect: {
    severity: "critical",
    notify: ["ops"],
    message: "Action error rate exceeds 10%",
  },
});

// ── Registration ────────────────────────────────────────

export interface RegisterSystemAlertsOptions {
  alertEngine: AlertEngine;
  metricsCollector: InMemoryMetricsCollector;
}

/**
 * Register pre-defined system alert rules and update derived metrics.
 *
 * Call `updateErrorRateGauge()` on the returned object before evaluating
 * alerts to refresh the computed error rate gauge.
 *
 * Usage:
 * ```ts
 * const sysAlerts = registerSystemAlerts({ alertEngine, metricsCollector });
 * // Before alert evaluation:
 * sysAlerts.updateErrorRateGauge();
 * alertEngine.evaluateAll();
 * ```
 */
export function registerSystemAlerts(opts: RegisterSystemAlertsOptions): {
  /** Recompute and update the action.error_rate_pct gauge from current counters */
  updateErrorRateGauge: () => void;
} {
  const { alertEngine, metricsCollector } = opts;

  // Register the alert definition
  alertEngine.register(HIGH_ERROR_RATE_ALERT);

  // Helper to compute and set the error rate gauge
  function updateErrorRateGauge(): void {
    const executionCounters = metricsCollector.getCountersByPrefix("action.executions");
    const errorCounters = metricsCollector.getCountersByPrefix("action.errors");

    const totalExecutions = executionCounters.reduce((sum, c) => sum + c.value, 0);
    const totalErrors = errorCounters.reduce((sum, c) => sum + c.value, 0);

    const errorRate = totalExecutions > 0 ? (totalErrors / totalExecutions) * 100 : 0;

    metricsCollector.gauge("action.error_rate_pct", errorRate);
  }

  return { updateErrorRateGauge };
}
