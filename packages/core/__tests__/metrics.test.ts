import { beforeEach, describe, expect, it } from "bun:test";
import type { MetricsCollector } from "../src/observability/metrics";
import { InMemoryMetricsCollector, noopMetricsCollector } from "../src/observability/metrics";

describe("InMemoryMetricsCollector", () => {
  let metrics: InMemoryMetricsCollector;

  beforeEach(() => {
    metrics = new InMemoryMetricsCollector();
  });

  // ── Counter ────────────────────────────────────────────

  describe("increment (counter)", () => {
    it("starts at 1 on first increment", () => {
      metrics.increment("action.executed", { action: "create_order" });
      expect(metrics.getCounter("action.executed", { action: "create_order" })).toBe(1);
    });

    it("aggregates multiple increments for the same name+tags", () => {
      metrics.increment("action.executed", { action: "create_order" });
      metrics.increment("action.executed", { action: "create_order" });
      metrics.increment("action.executed", { action: "create_order" });
      expect(metrics.getCounter("action.executed", { action: "create_order" })).toBe(3);
    });

    it("tracks different tag combinations independently", () => {
      metrics.increment("action.executed", { action: "create_order", status: "success" });
      metrics.increment("action.executed", { action: "create_order", status: "success" });
      metrics.increment("action.executed", { action: "create_order", status: "failed" });
      expect(
        metrics.getCounter("action.executed", { action: "create_order", status: "success" }),
      ).toBe(2);
      expect(
        metrics.getCounter("action.executed", { action: "create_order", status: "failed" }),
      ).toBe(1);
    });

    it("returns 0 for unknown counter", () => {
      expect(metrics.getCounter("nonexistent")).toBe(0);
    });

    it("works without tags", () => {
      metrics.increment("total");
      metrics.increment("total");
      expect(metrics.getCounter("total")).toBe(2);
    });
  });

  // ── Gauge ──────────────────────────────────────────────

  describe("gauge", () => {
    it("sets the gauge value", () => {
      metrics.gauge("queue.depth", 42);
      expect(metrics.getGauge("queue.depth")).toBe(42);
    });

    it("overwrites previous gauge value", () => {
      metrics.gauge("queue.depth", 10);
      metrics.gauge("queue.depth", 25);
      expect(metrics.getGauge("queue.depth")).toBe(25);
    });

    it("tracks different tag combinations independently", () => {
      metrics.gauge("connections", 5, { pool: "read" });
      metrics.gauge("connections", 3, { pool: "write" });
      expect(metrics.getGauge("connections", { pool: "read" })).toBe(5);
      expect(metrics.getGauge("connections", { pool: "write" })).toBe(3);
    });

    it("returns undefined for unknown gauge", () => {
      expect(metrics.getGauge("nonexistent")).toBeUndefined();
    });
  });

  // ── Histogram ──────────────────────────────────────────

  describe("histogram", () => {
    it("records individual observations", () => {
      metrics.histogram("action.duration_ms", 120, { action: "create_order" });
      metrics.histogram("action.duration_ms", 85, { action: "create_order" });
      metrics.histogram("action.duration_ms", 200, { action: "create_order" });
      expect(metrics.getHistogramValues("action.duration_ms")).toEqual([120, 85, 200]);
    });

    it("returns empty array for unknown histogram", () => {
      expect(metrics.getHistogramValues("nonexistent")).toEqual([]);
    });
  });

  // ── Timing ─────────────────────────────────────────────

  describe("timing", () => {
    it("records as histogram observation", () => {
      metrics.timing("action.duration_ms", 150, { action: "approve" });
      const values = metrics.getHistogramValues("action.duration_ms");
      expect(values).toEqual([150]);
    });
  });

  // ── getMetrics ─────────────────────────────────────────

  describe("getMetrics", () => {
    it("returns all metrics across types", () => {
      metrics.increment("action.executed", { action: "create" });
      metrics.gauge("queue.depth", 5);
      metrics.histogram("action.duration_ms", 100);

      const all = metrics.getMetrics();
      expect(all.length).toBe(3);

      const types = all.map((m) => m.type);
      expect(types).toContain("counter");
      expect(types).toContain("gauge");
      expect(types).toContain("histogram");
    });

    it("returns empty array when no metrics collected", () => {
      expect(metrics.getMetrics()).toEqual([]);
    });

    it("snapshot includes correct fields", () => {
      metrics.increment("action.executed", { action: "submit", schema: "order" });
      const [snapshot] = metrics.getMetrics();
      expect(snapshot.name).toBe("action.executed");
      expect(snapshot.type).toBe("counter");
      expect(snapshot.value).toBe(1);
      expect(snapshot.tags).toEqual({ action: "submit", schema: "order" });
      expect(typeof snapshot.timestamp).toBe("number");
    });
  });

  // ── reset ──────────────────────────────────────────────

  describe("reset", () => {
    it("clears all collected metrics", () => {
      metrics.increment("action.executed");
      metrics.gauge("queue.depth", 5);
      metrics.histogram("action.duration_ms", 100);

      metrics.reset();

      expect(metrics.getMetrics()).toEqual([]);
      expect(metrics.getCounter("action.executed")).toBe(0);
      expect(metrics.getGauge("queue.depth")).toBeUndefined();
      expect(metrics.getHistogramValues("action.duration_ms")).toEqual([]);
    });
  });

  // ── Tag ordering independence ──────────────────────────

  describe("tag ordering", () => {
    it("treats same tags in different order as identical", () => {
      metrics.increment("action.executed", { schema: "order", action: "create" });
      metrics.increment("action.executed", { action: "create", schema: "order" });
      expect(metrics.getCounter("action.executed", { action: "create", schema: "order" })).toBe(2);
    });
  });
});

// ── noopMetricsCollector ─────────────────────────────────

describe("noopMetricsCollector", () => {
  it("implements MetricsCollector interface", () => {
    const collector: MetricsCollector = noopMetricsCollector;
    // Should not throw
    collector.increment("test");
    collector.gauge("test", 1);
    collector.histogram("test", 1);
    collector.timing("test", 1);
    expect(collector.getMetrics()).toEqual([]);
  });
});
