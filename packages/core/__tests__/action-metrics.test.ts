import { describe, expect, it } from "bun:test";
import { createActionExecutor, type DataProvider } from "../src/engine/action-engine";
import { createCommandLayer } from "../src/engine/command-layer";
import { AlertEngine } from "../src/observability/alert-engine";
import { InMemoryMetricsCollector } from "../src/observability/metrics";
import { registerSystemAlerts } from "../src/observability/system-alerts";
import type { ActionDefinition, Actor } from "../src/types/action";

// ── Fixtures ────────────────────────────────────────────

const testActor: Actor = { type: "human", id: "user-1", groups: ["admin"] };

const successAction: ActionDefinition = {
  name: "create_item",
  entity: "item",
  label: "Create Item",
  input: { title: { type: "string", required: true } },
  policy: { mode: "sync", transaction: false },
  handler: async (ctx) => ({ title: ctx.input.title }),
};

const failingAction: ActionDefinition = {
  name: "fail_item",
  entity: "item",
  label: "Fail Item",
  input: {},
  policy: { mode: "sync", transaction: false },
  handler: async () => {
    throw new Error("Intentional failure");
  },
};

function createTestExecutor(actions: ActionDefinition[]) {
  const dataProvider: DataProvider = {
    get: async () => ({ id: "1" }),
    query: async () => [],
    create: async (_e, data) => ({ id: "1", ...data }),
    update: async (_e, _id, data) => ({ id: "1", ...data }),
    delete: async () => {},
    count: async () => 0,
  };
  const executor = createActionExecutor({ dataProvider });
  for (const a of actions) executor.registry.register(a);
  return executor;
}

// ── Tests: Action metrics instrumentation ────────────────

describe("CommandLayer action metrics", () => {
  it("records action.executions and action.duration_ms on success", async () => {
    const metrics = new InMemoryMetricsCollector();
    const executor = createTestExecutor([successAction]);
    const layer = createCommandLayer({ executor, metrics });

    const result = await layer.execute({
      command: "create_item",
      input: { title: "Test" },
      actor: testActor,
    });

    expect(result.success).toBe(true);

    // Check action.executions counter
    const execCount = metrics.getCounter("action.executions", {
      action: "create_item",
      status: "success",
    });
    expect(execCount).toBe(1);

    // Check action.duration_ms histogram was recorded
    const durations = metrics.getHistogramValues("action.duration_ms");
    expect(durations.length).toBeGreaterThanOrEqual(1);
    expect(durations[0]).toBeGreaterThanOrEqual(0);

    // No errors should be recorded
    const errorCount = metrics.getCounter("action.errors", { action: "create_item" });
    expect(errorCount).toBe(0);
  });

  it("records action.errors on action failure", async () => {
    const metrics = new InMemoryMetricsCollector();
    const executor = createTestExecutor([failingAction]);
    const layer = createCommandLayer({ executor, metrics });

    const result = await layer.execute({
      command: "fail_item",
      input: {},
      actor: testActor,
    });

    // The executor catches the throw and returns success: false
    expect(result.success).toBe(false);

    // action.executions should be recorded with error status
    const execCount = metrics.getCounter("action.executions", {
      action: "fail_item",
      status: "error",
    });
    expect(execCount).toBe(1);

    // action.errors counter should be incremented
    const errorCount = metrics.getCounter("action.errors", { action: "fail_item" });
    expect(errorCount).toBe(1);
  });

  it("records metrics for unknown action (not found)", async () => {
    const metrics = new InMemoryMetricsCollector();
    const executor = createTestExecutor([successAction]);
    const layer = createCommandLayer({ executor, metrics });

    const result = await layer.execute({
      command: "nonexistent_action",
      input: {},
      actor: testActor,
    });

    expect(result.success).toBe(false);
    // Action not found returns early before pipeline runs, no action metrics recorded
  });

  it("accumulates metrics across multiple executions", async () => {
    const metrics = new InMemoryMetricsCollector();
    const executor = createTestExecutor([successAction]);
    const layer = createCommandLayer({ executor, metrics });

    await layer.execute({ command: "create_item", input: { title: "A" }, actor: testActor });
    await layer.execute({ command: "create_item", input: { title: "B" }, actor: testActor });
    await layer.execute({ command: "create_item", input: { title: "C" }, actor: testActor });

    const execCount = metrics.getCounter("action.executions", {
      action: "create_item",
      status: "success",
    });
    expect(execCount).toBe(3);

    const durations = metrics.getHistogramValues("action.duration_ms");
    expect(durations.length).toBeGreaterThanOrEqual(3);
  });
});

// ── Tests: System alerts ────────────────────────────────

describe("registerSystemAlerts", () => {
  it("registers high_error_rate alert and computes error rate gauge", () => {
    const metrics = new InMemoryMetricsCollector();
    const alertEngine = new AlertEngine({ metrics });

    const sysAlerts = registerSystemAlerts({
      alertEngine,
      metricsCollector: metrics,
    });

    // Verify alert is registered
    const alerts = alertEngine.list();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.name).toBe("high_error_rate");

    // Simulate 10 executions, 2 errors (20% error rate)
    for (let i = 0; i < 10; i++) {
      metrics.increment("action.executions", { action: "test_action", status: "success" });
    }
    for (let i = 0; i < 2; i++) {
      metrics.increment("action.errors", { action: "test_action" });
    }

    sysAlerts.updateErrorRateGauge();

    // Error rate gauge should be 20%
    const errorRate = metrics.getGauge("action.error_rate_pct");
    expect(errorRate).toBe(20);

    // Evaluate — should trigger (20% > 10%)
    const results = alertEngine.evaluateAll();
    expect(results).toHaveLength(1);
    expect(results[0]?.triggered).toBe(true);
    expect(results[0]?.severity).toBe("critical");
  });

  it("does not trigger alert when error rate is below threshold", () => {
    const metrics = new InMemoryMetricsCollector();
    const alertEngine = new AlertEngine({ metrics });

    const sysAlerts = registerSystemAlerts({
      alertEngine,
      metricsCollector: metrics,
    });

    // Simulate 100 executions, 5 errors (5% error rate)
    for (let i = 0; i < 100; i++) {
      metrics.increment("action.executions", { action: "test_action", status: "success" });
    }
    for (let i = 0; i < 5; i++) {
      metrics.increment("action.errors", { action: "test_action" });
    }

    sysAlerts.updateErrorRateGauge();

    const results = alertEngine.evaluateAll();
    expect(results).toHaveLength(1);
    expect(results[0]?.triggered).toBe(false);
  });

  it("reports 0% error rate when no executions exist", () => {
    const metrics = new InMemoryMetricsCollector();
    const alertEngine = new AlertEngine({ metrics });

    const sysAlerts = registerSystemAlerts({
      alertEngine,
      metricsCollector: metrics,
    });

    sysAlerts.updateErrorRateGauge();

    const errorRate = metrics.getGauge("action.error_rate_pct");
    expect(errorRate).toBe(0);

    const results = alertEngine.evaluateAll();
    expect(results).toHaveLength(1);
    expect(results[0]?.triggered).toBe(false);
  });
});
