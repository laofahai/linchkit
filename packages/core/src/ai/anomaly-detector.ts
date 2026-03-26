/**
 * AI Anomaly Detector
 *
 * Detects unusual patterns in AI agent behavior that may indicate
 * compromise, abuse, or malfunction. Operates on sliding time windows
 * of usage data.
 *
 * See spec 27_ai_security.md §1.5 (Rate Abuse) and M2 requirements
 * (anomalous behavior detection).
 *
 * Detection strategies:
 * 1. Request spike detection — sudden increase vs baseline
 * 2. Error rate monitoring — too many blocked/failed calls
 * 3. Repetitive action detection — same action called repeatedly
 * 4. Off-hours activity — AI calls outside normal business hours
 * 5. Diverse action anomaly — sudden use of many different actions
 */

// ── Types ─────────────────────────────────────────────────────

/** Types of anomalies that can be detected */
export type AnomalyType =
  | "request_spike"
  | "high_error_rate"
  | "repetitive_action"
  | "off_hours_activity"
  | "diverse_action_burst"
  | "budget_burn_rate"
  | "custom";

/** Severity of detected anomaly */
export type AnomalySeverity = "info" | "warning" | "alert" | "critical";

/** A single detected anomaly */
export interface AnomalyDetection {
  /** Type of anomaly */
  type: AnomalyType;

  /** Severity level */
  severity: AnomalySeverity;

  /** Human-readable description */
  description: string;

  /** Tenant where the anomaly was detected */
  tenantId?: string;

  /** Actor associated with the anomaly */
  actorId?: string;

  /** Timestamp of detection */
  detectedAt: Date;

  /** Metric values that triggered the detection */
  metrics: Record<string, number>;

  /** Thresholds that were exceeded */
  thresholds: Record<string, number>;
}

/** A usage event fed into the anomaly detector */
export interface UsageEvent {
  /** Timestamp of the event */
  timestamp: Date;

  /** Tenant ID */
  tenantId?: string;

  /** Actor ID */
  actorId?: string;

  /** Action name (if applicable) */
  actionName?: string;

  /** Whether the request was successful */
  success: boolean;

  /** Cost of the operation (USD) */
  cost?: number;

  /** Token count */
  tokens?: number;
}

/** Configuration for the anomaly detector */
export interface AnomalyDetectorConfig {
  /** Spike detection: multiplier over baseline to trigger alert (default: 3.0) */
  spikeMultiplier?: number;

  /** Error rate threshold as fraction (default: 0.5 = 50%) */
  errorRateThreshold?: number;

  /** Minimum events in window before anomaly detection activates (default: 10) */
  minEventsForDetection?: number;

  /** Time window size in milliseconds (default: 5 minutes = 300_000) */
  windowSizeMs?: number;

  /** Repetitive action threshold — same action N times in window (default: 20) */
  repetitiveActionThreshold?: number;

  /** Budget burn rate threshold — fraction of daily budget consumed per hour (default: 0.5) */
  budgetBurnRateThreshold?: number;

  /** Diverse action threshold — distinct actions in a short burst (default: 15) */
  diverseActionThreshold?: number;

  /** Business hours start (0-23, default: 6) */
  businessHoursStart?: number;

  /** Business hours end (0-23, default: 22) */
  businessHoursEnd?: number;

  /** Whether to detect off-hours activity (default: false — disabled by default) */
  detectOffHours?: boolean;

  /** Callback when an anomaly is detected */
  onAnomaly?: (anomaly: AnomalyDetection) => void;
}

// ── Anomaly Detector ───────────────────────────────────────────

/**
 * Sliding-window anomaly detector for AI usage patterns.
 *
 * Feed usage events via `recordEvent()` and call `detect()` to check
 * for anomalies. The detector maintains a bounded event buffer and
 * computes statistics over configurable time windows.
 */
export class AnomalyDetector {
  private readonly events: UsageEvent[] = [];
  private readonly config: Required<
    Pick<
      AnomalyDetectorConfig,
      | "spikeMultiplier"
      | "errorRateThreshold"
      | "minEventsForDetection"
      | "windowSizeMs"
      | "repetitiveActionThreshold"
      | "budgetBurnRateThreshold"
      | "diverseActionThreshold"
      | "businessHoursStart"
      | "businessHoursEnd"
      | "detectOffHours"
    >
  >;
  private readonly onAnomaly?: (anomaly: AnomalyDetection) => void;

  /** Baseline request rate (events per window), updated via exponential moving average */
  private baselineRate = 0;

  /** Number of windows observed (for baseline warmup) */
  private windowsObserved = 0;

  /** Maximum events to keep in buffer */
  private static readonly MAX_BUFFER = 10_000;

  /** Smoothing factor for exponential moving average */
  private static readonly EMA_ALPHA = 0.3;

  constructor(config?: AnomalyDetectorConfig) {
    this.config = {
      spikeMultiplier: config?.spikeMultiplier ?? 3.0,
      errorRateThreshold: config?.errorRateThreshold ?? 0.5,
      minEventsForDetection: config?.minEventsForDetection ?? 10,
      windowSizeMs: config?.windowSizeMs ?? 300_000,
      repetitiveActionThreshold: config?.repetitiveActionThreshold ?? 20,
      budgetBurnRateThreshold: config?.budgetBurnRateThreshold ?? 0.5,
      diverseActionThreshold: config?.diverseActionThreshold ?? 15,
      businessHoursStart: config?.businessHoursStart ?? 6,
      businessHoursEnd: config?.businessHoursEnd ?? 22,
      detectOffHours: config?.detectOffHours ?? false,
    };
    this.onAnomaly = config?.onAnomaly;
  }

  /** Record a usage event for anomaly analysis */
  recordEvent(event: UsageEvent): void {
    this.events.push(event);

    // Trim buffer to prevent unbounded growth
    if (this.events.length > AnomalyDetector.MAX_BUFFER) {
      this.events.splice(0, this.events.length >> 1);
    }
  }

  /**
   * Run anomaly detection on current event buffer.
   *
   * Returns all detected anomalies. Also fires onAnomaly callback
   * for each detection.
   */
  detect(options?: { tenantId?: string; actorId?: string }): AnomalyDetection[] {
    const now = new Date();
    const windowStart = new Date(now.getTime() - this.config.windowSizeMs);
    const anomalies: AnomalyDetection[] = [];

    // Get events in the current window, optionally filtered
    let windowEvents = this.events.filter((e) => e.timestamp >= windowStart);
    if (options?.tenantId) {
      windowEvents = windowEvents.filter((e) => e.tenantId === options.tenantId);
    }
    if (options?.actorId) {
      windowEvents = windowEvents.filter((e) => e.actorId === options.actorId);
    }

    // Skip detection if too few events
    if (windowEvents.length < this.config.minEventsForDetection) {
      // Still update baseline
      this.updateBaseline(windowEvents.length);
      return [];
    }

    // 1. Request spike detection
    const spikeAnomaly = this.detectSpike(windowEvents, now, options);
    if (spikeAnomaly) anomalies.push(spikeAnomaly);

    // 2. Error rate detection
    const errorAnomaly = this.detectHighErrorRate(windowEvents, now, options);
    if (errorAnomaly) anomalies.push(errorAnomaly);

    // 3. Repetitive action detection
    const repetitiveAnomaly = this.detectRepetitiveAction(windowEvents, now, options);
    if (repetitiveAnomaly) anomalies.push(repetitiveAnomaly);

    // 4. Off-hours activity
    if (this.config.detectOffHours) {
      const offHoursAnomaly = this.detectOffHours(windowEvents, now, options);
      if (offHoursAnomaly) anomalies.push(offHoursAnomaly);
    }

    // 5. Diverse action burst
    const diverseAnomaly = this.detectDiverseActionBurst(windowEvents, now, options);
    if (diverseAnomaly) anomalies.push(diverseAnomaly);

    // 6. Budget burn rate
    const burnAnomaly = this.detectBudgetBurnRate(windowEvents, now, options);
    if (burnAnomaly) anomalies.push(burnAnomaly);

    // Update baseline
    this.updateBaseline(windowEvents.length);

    // Fire callbacks
    for (const a of anomalies) {
      this.onAnomaly?.(a);
    }

    return anomalies;
  }

  /** Get the current baseline request rate */
  getBaselineRate(): number {
    return this.baselineRate;
  }

  /** Get the number of events in buffer */
  getEventCount(): number {
    return this.events.length;
  }

  /** Clear all events (for testing) */
  clear(): void {
    this.events.length = 0;
    this.baselineRate = 0;
    this.windowsObserved = 0;
  }

  // ── Private Detection Methods ─────────────────────────────

  private detectSpike(
    windowEvents: UsageEvent[],
    now: Date,
    options?: { tenantId?: string; actorId?: string },
  ): AnomalyDetection | undefined {
    const currentRate = windowEvents.length;

    // Need at least 3 baseline observations before spike detection
    if (this.windowsObserved < 3) return undefined;

    const threshold = this.baselineRate * this.config.spikeMultiplier;
    if (currentRate > threshold && threshold > 0) {
      return {
        type: "request_spike",
        severity: currentRate > threshold * 2 ? "critical" : "alert",
        description: `Request rate spike: ${currentRate} requests in window (baseline: ${this.baselineRate.toFixed(1)}, threshold: ${threshold.toFixed(1)})`,
        tenantId: options?.tenantId,
        actorId: options?.actorId,
        detectedAt: now,
        metrics: { currentRate, baselineRate: this.baselineRate },
        thresholds: { spikeThreshold: threshold },
      };
    }

    return undefined;
  }

  private detectHighErrorRate(
    windowEvents: UsageEvent[],
    now: Date,
    options?: { tenantId?: string; actorId?: string },
  ): AnomalyDetection | undefined {
    const total = windowEvents.length;
    const errors = windowEvents.filter((e) => !e.success).length;
    const errorRate = errors / total;

    if (errorRate >= this.config.errorRateThreshold) {
      return {
        type: "high_error_rate",
        severity: errorRate >= 0.8 ? "critical" : "alert",
        description: `High error rate: ${(errorRate * 100).toFixed(1)}% of ${total} requests failed`,
        tenantId: options?.tenantId,
        actorId: options?.actorId,
        detectedAt: now,
        metrics: { errorRate, totalEvents: total, errorCount: errors },
        thresholds: { errorRateThreshold: this.config.errorRateThreshold },
      };
    }

    return undefined;
  }

  private detectRepetitiveAction(
    windowEvents: UsageEvent[],
    now: Date,
    options?: { tenantId?: string; actorId?: string },
  ): AnomalyDetection | undefined {
    const actionCounts = new Map<string, number>();
    for (const e of windowEvents) {
      if (e.actionName) {
        actionCounts.set(e.actionName, (actionCounts.get(e.actionName) ?? 0) + 1);
      }
    }

    for (const [actionName, count] of actionCounts) {
      if (count >= this.config.repetitiveActionThreshold) {
        return {
          type: "repetitive_action",
          severity: "warning",
          description: `Repetitive action: "${actionName}" called ${count} times in window (threshold: ${this.config.repetitiveActionThreshold})`,
          tenantId: options?.tenantId,
          actorId: options?.actorId,
          detectedAt: now,
          metrics: { actionCount: count },
          thresholds: {
            repetitiveActionThreshold: this.config.repetitiveActionThreshold,
          },
        };
      }
    }

    return undefined;
  }

  private detectOffHours(
    windowEvents: UsageEvent[],
    now: Date,
    options?: { tenantId?: string; actorId?: string },
  ): AnomalyDetection | undefined {
    const hour = now.getHours();
    const isOffHours =
      hour < this.config.businessHoursStart || hour >= this.config.businessHoursEnd;

    if (isOffHours && windowEvents.length > 0) {
      return {
        type: "off_hours_activity",
        severity: "info",
        description: `AI activity detected outside business hours (${this.config.businessHoursStart}:00-${this.config.businessHoursEnd}:00): ${windowEvents.length} events at hour ${hour}`,
        tenantId: options?.tenantId,
        actorId: options?.actorId,
        detectedAt: now,
        metrics: { eventCount: windowEvents.length, hour },
        thresholds: {
          businessHoursStart: this.config.businessHoursStart,
          businessHoursEnd: this.config.businessHoursEnd,
        },
      };
    }

    return undefined;
  }

  private detectDiverseActionBurst(
    windowEvents: UsageEvent[],
    now: Date,
    options?: { tenantId?: string; actorId?: string },
  ): AnomalyDetection | undefined {
    const distinctActions = new Set<string>();
    for (const e of windowEvents) {
      if (e.actionName) distinctActions.add(e.actionName);
    }

    if (distinctActions.size >= this.config.diverseActionThreshold) {
      return {
        type: "diverse_action_burst",
        severity: "warning",
        description: `Diverse action burst: ${distinctActions.size} distinct actions in window (threshold: ${this.config.diverseActionThreshold})`,
        tenantId: options?.tenantId,
        actorId: options?.actorId,
        detectedAt: now,
        metrics: { distinctActions: distinctActions.size },
        thresholds: {
          diverseActionThreshold: this.config.diverseActionThreshold,
        },
      };
    }

    return undefined;
  }

  private detectBudgetBurnRate(
    windowEvents: UsageEvent[],
    now: Date,
    options?: { tenantId?: string; actorId?: string },
  ): AnomalyDetection | undefined {
    const totalCost = windowEvents.reduce((sum, e) => sum + (e.cost ?? 0), 0);

    // Calculate hourly burn rate: extrapolate from window size to 1 hour
    const windowHours = this.config.windowSizeMs / 3_600_000;
    const hourlyBurnRate = windowHours > 0 ? totalCost / windowHours : 0;

    // Threshold is fraction of a $100/day budget (roughly $4.17/hour)
    // If burn rate exceeds threshold * daily budget / 24, flag it
    const hourlyBudget = 100 / 24; // Assume $100/day as reference
    const threshold = hourlyBudget * this.config.budgetBurnRateThreshold;

    if (hourlyBurnRate > threshold && totalCost > 0) {
      return {
        type: "budget_burn_rate",
        severity: hourlyBurnRate > threshold * 2 ? "critical" : "alert",
        description: `High budget burn rate: $${hourlyBurnRate.toFixed(2)}/hour (threshold: $${threshold.toFixed(2)}/hour)`,
        tenantId: options?.tenantId,
        actorId: options?.actorId,
        detectedAt: now,
        metrics: { hourlyBurnRate, totalCost, windowHours },
        thresholds: { burnRateThreshold: threshold },
      };
    }

    return undefined;
  }

  // ── Private Baseline ──────────────────────────────────────

  private updateBaseline(currentCount: number): void {
    this.windowsObserved++;
    if (this.windowsObserved === 1) {
      this.baselineRate = currentCount;
    } else {
      // Exponential moving average
      this.baselineRate =
        AnomalyDetector.EMA_ALPHA * currentCount +
        (1 - AnomalyDetector.EMA_ALPHA) * this.baselineRate;
    }
  }
}
