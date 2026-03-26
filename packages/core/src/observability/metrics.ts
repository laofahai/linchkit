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

  /**
   * Compute percentiles for a named histogram metric.
   * Returns an object with p50, p90, p95, p99, min, max, count, and mean.
   * Returns null if no observations exist for the given name.
   */
  getPercentiles(
    name: string,
  ): {
    count: number;
    min: number;
    max: number;
    mean: number;
    p50: number;
    p90: number;
    p95: number;
    p99: number;
  } | null {
    const values = this.getHistogramValues(name);
    if (values.length === 0) return null;

    const sorted = [...values].sort((a, b) => a - b);
    const count = sorted.length;
    const sum = sorted.reduce((acc, v) => acc + v, 0);

    return {
      count,
      min: sorted[0],
      max: sorted[count - 1],
      mean: sum / count,
      p50: percentile(sorted, 0.5),
      p90: percentile(sorted, 0.9),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
    };
  }

  /**
   * Get all counters matching a name prefix.
   * Returns an array of { tags, value } entries.
   */
  getCountersByPrefix(prefix: string): Array<{ name: string; tags: Record<string, string>; value: number }> {
    const result: Array<{ name: string; tags: Record<string, string>; value: number }> = [];
    for (const snapshot of this.counters.values()) {
      if (snapshot.name.startsWith(prefix)) {
        result.push({ name: snapshot.name, tags: { ...snapshot.tags }, value: snapshot.value });
      }
    }
    return result;
  }

  /**
   * Build a summary of all collected metrics suitable for health endpoints.
   * Groups counters by name, provides percentiles for histograms, and includes gauges.
   */
  getSummary(): MetricsSummary {
    // Aggregate counters by name
    const counterTotals = new Map<string, number>();
    for (const snapshot of this.counters.values()) {
      counterTotals.set(snapshot.name, (counterTotals.get(snapshot.name) ?? 0) + snapshot.value);
    }
    const counters: Record<string, number> = {};
    for (const [name, total] of counterTotals) {
      counters[name] = total;
    }

    // Collect unique histogram names and compute percentiles
    const histogramNames = new Set<string>();
    for (const s of this.histograms) {
      histogramNames.add(s.name);
    }
    const histogramSummaries: Record<string, ReturnType<InMemoryMetricsCollector["getPercentiles"]>> = {};
    for (const name of histogramNames) {
      histogramSummaries[name] = this.getPercentiles(name);
    }

    // Collect gauges
    const gauges: Record<string, number> = {};
    for (const snapshot of this.gauges.values()) {
      // Use the full key with tags for uniqueness
      const tagStr = Object.entries(snapshot.tags)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join(",");
      const key = tagStr ? `${snapshot.name}{${tagStr}}` : snapshot.name;
      gauges[key] = snapshot.value;
    }

    return { counters, gauges, histograms: histogramSummaries };
  }

  /** Clear all collected metrics */
  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.length = 0;
  }
}

// ── Percentile helper ──────────────────────────────────

/** Compute the p-th percentile from a sorted array using nearest-rank method */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

// ── MetricsSummary type ────────────────────────────────

export interface MetricsSummary {
  /** Counter totals grouped by metric name */
  counters: Record<string, number>;
  /** Current gauge values (keyed by name or name{tags}) */
  gauges: Record<string, number>;
  /** Histogram percentile summaries keyed by metric name */
  histograms: Record<
    string,
    {
      count: number;
      min: number;
      max: number;
      mean: number;
      p50: number;
      p90: number;
      p95: number;
      p99: number;
    } | null
  >;
}

/** No-op metrics collector — silently discards all metrics */
export const noopMetricsCollector: MetricsCollector = {
  increment: () => {},
  gauge: () => {},
  histogram: () => {},
  timing: () => {},
  getMetrics: () => [],
};
