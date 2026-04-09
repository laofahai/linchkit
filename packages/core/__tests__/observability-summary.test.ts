import { describe, expect, it } from "bun:test";
import { HealthCheckRegistry } from "../src/deployment/health-check";
import { InMemoryMetricsCollector } from "../src/observability/metrics";
import { buildObservabilitySummary } from "../src/observability/observability-summary";

describe("buildObservabilitySummary", () => {
  it("returns metrics summary with counters, gauges, and histograms", async () => {
    const metrics = new InMemoryMetricsCollector();
    metrics.increment("action.executions", { action: "create_order", status: "success" });
    metrics.increment("action.executions", { action: "create_order", status: "success" });
    metrics.increment("action.errors", { action: "create_order" });
    metrics.gauge("active_connections", 5);
    metrics.timing("action.duration_ms", 120, { action: "create_order" });
    metrics.timing("action.duration_ms", 80, { action: "create_order" });

    const summary = await buildObservabilitySummary({ metrics });

    expect(summary.timestamp).toBeDefined();
    expect(summary.metrics.counters["action.executions"]).toBe(2);
    expect(summary.metrics.counters["action.errors"]).toBe(1);
    expect(summary.metrics.gauges.active_connections).toBe(5);
    expect(summary.metrics.histograms["action.duration_ms"]).toBeDefined();
    expect(summary.metrics.histograms["action.duration_ms"]?.count).toBe(2);
    expect(summary.metrics.histograms["action.duration_ms"]?.min).toBe(80);
    expect(summary.metrics.histograms["action.duration_ms"]?.max).toBe(120);
    // No health checks provided
    expect(summary.health).toBeUndefined();
  });

  it("includes health check results when healthChecks provided", async () => {
    const metrics = new InMemoryMetricsCollector();
    const healthChecks = new HealthCheckRegistry();
    healthChecks.register("liveness", () => ({
      name: "liveness",
      status: "healthy",
      message: "OK",
      durationMs: 0,
    }));
    healthChecks.register("database", () => ({
      name: "database",
      status: "degraded",
      message: "Slow",
      durationMs: 50,
    }));

    const summary = await buildObservabilitySummary({ metrics, healthChecks });

    expect(summary.health).toBeDefined();
    expect(summary.health?.status).toBe("degraded");
    expect(summary.health?.checks).toHaveLength(2);
    expect(summary.health?.checks[0]?.name).toBe("liveness");
    expect(summary.health?.checks[1]?.name).toBe("database");
  });

  it("returns empty metrics when collector has no data", async () => {
    const metrics = new InMemoryMetricsCollector();

    const summary = await buildObservabilitySummary({ metrics });

    expect(summary.metrics.counters).toEqual({});
    expect(summary.metrics.gauges).toEqual({});
    expect(summary.metrics.histograms).toEqual({});
  });
});
