/**
 * Metrics Collector — Pluggable observability metrics interface and in-memory implementation.
 *
 * Tracks counters, gauges, and histograms with optional tags.
 * Default InMemoryMetricsCollector stores everything in memory for dev/test.
 * Users can implement MetricsCollector for Prometheus, StatsD, etc.
 */

// ── Interface ────────────────────────────────────────────

export interface MetricSnapshot {
  name: string;
  type: "counter" | "gauge" | "histogram";
  value: number;
  tags: Record<string, string>;
  timestamp: number;
}

export interface MetricsCollector {
  /** Increment a counter by 1 */
  increment(name: string, tags?: Record<string, string>): void;
  /** Set a gauge to an absolute value */
  gauge(name: string, value: number, tags?: Record<string, string>): void;
  /** Record a histogram observation (e.g. request size, queue depth) */
  histogram(name: string, value: number, tags?: Record<string, string>): void;
  /** Record a timing observation in milliseconds (sugar for histogram) */
  timing(name: string, durationMs: number, tags?: Record<string, string>): void;
  /** Return all collected metric snapshots */
  getMetrics(): MetricSnapshot[];
}

// ── Helpers ──────────────────────────────────────────────

/** Deterministic key for deduplication of counters/gauges */
function metricKey(name: string, tags: Record<string, string>): string {
  const sorted = Object.keys(tags)
    .sort()
    .map((k) => `${k}=${tags[k]}`)
    .join(",");
  return `${name}|${sorted}`;
}

// ── InMemoryMetricsCollector ─────────────────────────────

/**
 * Default in-memory implementation.
 *
 * - Counters are aggregated (increment adds to existing value).
 * - Gauges store the latest value for each name+tags combination.
 * - Histograms store every observation as a separate snapshot.
 * - `timing` is a convenience alias for `histogram`.
 */
export class InMemoryMetricsCollector implements MetricsCollector {
  /** Aggregated counters keyed by name+tags */
  private counters = new Map<string, MetricSnapshot>();
  /** Latest gauge values keyed by name+tags */
  private gauges = new Map<string, MetricSnapshot>();
  /** Histogram observations (ring buffer, max 10000) */
  private histograms: MetricSnapshot[] = [];
  private static readonly MAX_HISTOGRAM_SIZE = 10_000;

  increment(name: string, tags: Record<string, string> = {}): void {
    const key = metricKey(name, tags);
    const existing = this.counters.get(key);
    if (existing) {
      existing.value += 1;
      existing.timestamp = Date.now();
    } else {
      this.counters.set(key, {
        name,
        type: "counter",
        value: 1,
        tags: { ...tags },
        timestamp: Date.now(),
      });
    }
  }

  gauge(name: string, value: number, tags: Record<string, string> = {}): void {
    const key = metricKey(name, tags);
    this.gauges.set(key, {
      name,
      type: "gauge",
      value,
      tags: { ...tags },
      timestamp: Date.now(),
    });
  }

  histogram(name: string, value: number, tags: Record<string, string> = {}): void {
    if (this.histograms.length >= InMemoryMetricsCollector.MAX_HISTOGRAM_SIZE) {
      // Evict oldest half when full
      this.histograms = this.histograms.slice(this.histograms.length >> 1);
    }
    this.histograms.push({
      name,
      type: "histogram",
      value,
      tags: { ...tags },
      timestamp: Date.now(),
    });
  }

  timing(name: string, durationMs: number, tags: Record<string, string> = {}): void {
    this.histogram(name, durationMs, tags);
  }

  getMetrics(): MetricSnapshot[] {
    return [
      ...Array.from(this.counters.values()),
      ...Array.from(this.gauges.values()),
      ...this.histograms,
    ];
  }

  /** Get aggregated counter value for a specific name+tags combination. Returns 0 if not found. */
  getCounter(name: string, tags: Record<string, string> = {}): number {
    const key = metricKey(name, tags);
    return this.counters.get(key)?.value ?? 0;
  }

  /** Get latest gauge value for a specific name+tags combination. Returns undefined if not found. */
  getGauge(name: string, tags: Record<string, string> = {}): number | undefined {
    const key = metricKey(name, tags);
    return this.gauges.get(key)?.value;
  }

  /** Get all histogram observations for a given name */
  getHistogramValues(name: string): number[] {
    return this.histograms.filter((s) => s.name === name).map((s) => s.value);
  }

  /** Clear all collected metrics */
  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.length = 0;
  }
}

/** No-op metrics collector — silently discards all metrics */
export const noopMetricsCollector: MetricsCollector = {
  increment: () => {},
  gauge: () => {},
  histogram: () => {},
  timing: () => {},
  getMetrics: () => [],
};
