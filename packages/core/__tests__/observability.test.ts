/**
 * Observability system tests — structured logger, percentiles, alert engine,
 * trace propagation through CommandLayer.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { createActionExecutor, type DataProvider } from "../src/engine/action-engine";
import { createCommandLayer } from "../src/engine/command-layer";
import { evaluateRules, type RuleEvalInput } from "../src/engine/rule-engine";
import {
  AlertEngine,
  type AlertEvaluationResult,
  defineSystemAlert,
} from "../src/observability/alert-engine";
import { InMemoryMetricsCollector } from "../src/observability/metrics";
import { createStructuredLogger, createTestLogSink } from "../src/observability/structured-logger";
import { getCurrentTrace, withTrace } from "../src/observability/trace-context";
import type { ActionDefinition, Actor } from "../src/types/action";
import type { RuleDefinition } from "../src/types/rule";

// ── Fixtures ──────────────────────────────────────────────

const testActor: Actor = { type: "human", id: "user-1", groups: ["admin"] };

function createTestDataProvider(): DataProvider {
  const data = new Map<string, Map<string, Record<string, unknown>>>();
  let counter = 0;

  return {
    async get(schema: string, id: string) {
      const record = data.get(schema)?.get(id);
      if (!record) throw new Error(`Not found: ${schema}/${id}`);
      return record;
    },
    async query() {
      return [];
    },
    async create(schema: string, input: Record<string, unknown>) {
      if (!data.has(schema)) data.set(schema, new Map());
      counter++;
      const id = `test_${counter}`;
      const record = { id, ...input };
      data.get(schema)?.set(id, record);
      return record;
    },
    async update(schema: string, id: string, updates: Record<string, unknown>) {
      const record = data.get(schema)?.get(id);
      if (!record) throw new Error(`Not found: ${schema}/${id}`);
      Object.assign(record, updates);
      return record;
    },
    async delete(schema: string, id: string) {
      data.get(schema)?.delete(id);
    },
    async count() {
      return 0;
    },
  };
}

// ── Structured Logger ─────────────────────────────────────

describe("StructuredLogger", () => {
  it("emits JSON log entries with timestamp and level", () => {
    const { entries, sink } = createTestLogSink();
    const logger = createStructuredLogger({ sink });

    logger.info("test message", { key: "value" });

    expect(entries.length).toBe(1);
    expect(entries[0].level).toBe("info");
    expect(entries[0].message).toBe("test message");
    expect(entries[0].key).toBe("value");
    expect(entries[0].timestamp).toBeDefined();
  });

  it("respects minLevel filter", () => {
    const { entries, sink } = createTestLogSink();
    const logger = createStructuredLogger({ sink, minLevel: "warn" });

    logger.debug("debug msg");
    logger.info("info msg");
    logger.warn("warn msg");
    logger.error("error msg");

    expect(entries.length).toBe(2);
    expect(entries[0].level).toBe("warn");
    expect(entries[1].level).toBe("error");
  });

  it("includes trace context when inside withTrace", async () => {
    const { entries, sink } = createTestLogSink();
    const logger = createStructuredLogger({ sink });

    await withTrace(() => {
      logger.info("inside trace");
    });

    expect(entries.length).toBe(1);
    expect(entries[0].traceId).toBeDefined();
    expect(typeof entries[0].traceId).toBe("string");
    expect(entries[0].depth).toBe(0);
  });

  it("does not include trace context outside withTrace", () => {
    const { entries, sink } = createTestLogSink();
    const logger = createStructuredLogger({ sink });

    logger.info("outside trace");

    expect(entries[0].traceId).toBeUndefined();
    expect(entries[0].depth).toBeUndefined();
  });

  it("includes defaultContext in every entry", () => {
    const { entries, sink } = createTestLogSink();
    const logger = createStructuredLogger({ sink, defaultContext: { service: "linchkit" } });

    logger.info("msg1");
    logger.warn("msg2");

    expect(entries[0].service).toBe("linchkit");
    expect(entries[1].service).toBe("linchkit");
  });

  it("includes nested trace depth", async () => {
    const { entries, sink } = createTestLogSink();
    const logger = createStructuredLogger({ sink });

    await withTrace(async () => {
      logger.info("depth 0");
      await withTrace(() => {
        logger.info("depth 1");
      });
    });

    expect(entries[0].depth).toBe(0);
    expect(entries[1].depth).toBe(1);
    // Same traceId for the entire chain
    expect(entries[0].traceId).toBe(entries[1].traceId);
  });
});

// ── Metrics Percentiles ──────────────────────────────────

describe("InMemoryMetricsCollector percentiles", () => {
  let metrics: InMemoryMetricsCollector;

  beforeEach(() => {
    metrics = new InMemoryMetricsCollector();
  });

  it("returns null for unknown histogram", () => {
    expect(metrics.getPercentiles("nonexistent")).toBeNull();
  });

  it("computes correct percentiles for a single value", () => {
    metrics.histogram("latency", 100);

    const p = metrics.getPercentiles("latency");
    expect(p?.count).toBe(1);
    expect(p?.min).toBe(100);
    expect(p?.max).toBe(100);
    expect(p?.mean).toBe(100);
    expect(p?.p50).toBe(100);
    expect(p?.p99).toBe(100);
  });

  it("computes correct percentiles for multiple values", () => {
    // Add 100 values: 1, 2, 3, ..., 100
    for (let i = 1; i <= 100; i++) {
      metrics.histogram("latency", i);
    }

    const p = metrics.getPercentiles("latency");
    expect(p?.count).toBe(100);
    expect(p?.min).toBe(1);
    expect(p?.max).toBe(100);
    expect(p?.mean).toBe(50.5);
    expect(p?.p50).toBe(50);
    expect(p?.p90).toBe(90);
    expect(p?.p95).toBe(95);
    expect(p?.p99).toBe(99);
  });

  it("getCountersByPrefix returns matching counters", () => {
    metrics.increment("action.executed", { action: "create" });
    metrics.increment("action.executed", { action: "update" });
    metrics.increment("rule.evaluated", { rule: "block" });

    const actionCounters = metrics.getCountersByPrefix("action.");
    expect(actionCounters.length).toBe(2);
    expect(actionCounters.every((c) => c.name.startsWith("action."))).toBe(true);
  });

  it("getSummary aggregates all metric types", () => {
    metrics.increment("action.executed", { action: "a" });
    metrics.increment("action.executed", { action: "a" });
    metrics.increment("action.executed", { action: "b" });
    metrics.gauge("queue.depth", 42);
    metrics.histogram("action.duration_ms", 100);
    metrics.histogram("action.duration_ms", 200);

    const summary = metrics.getSummary();

    // Counters: total for action.executed = 3 (2 + 1 across tag combos)
    expect(summary.counters["action.executed"]).toBe(3);

    // Gauges
    expect(Object.keys(summary.gauges).length).toBeGreaterThan(0);

    // Histograms
    expect(summary.histograms["action.duration_ms"]).toBeDefined();
    expect(summary.histograms["action.duration_ms"]?.count).toBe(2);
    expect(summary.histograms["action.duration_ms"]?.mean).toBe(150);
  });
});

// ── Alert Engine ─────────────────────────────────────────

describe("AlertEngine", () => {
  let metrics: InMemoryMetricsCollector;
  let firedAlerts: AlertEvaluationResult[];

  beforeEach(() => {
    metrics = new InMemoryMetricsCollector();
    firedAlerts = [];
  });

  it("defineSystemAlert returns a well-formed definition", () => {
    const alert = defineSystemAlert({
      name: "high_error_rate",
      condition: { metric: "action.executed", operator: "gt", value: 100 },
      effect: { notify: ["admin"], severity: "critical" },
    });

    expect(alert.name).toBe("high_error_rate");
    expect(alert.enabled).toBe(true);
  });

  it("evaluates alerts against counter metrics", () => {
    const engine = new AlertEngine({
      metrics,
      onAlert: (r) => firedAlerts.push(r),
    });

    engine.register(
      defineSystemAlert({
        name: "too_many_actions",
        condition: {
          metric: "action.executed",
          operator: "gt",
          value: 5,
          tags: { action: "create", status: "failed" },
        },
        effect: { notify: ["admin"], severity: "warning" },
      }),
    );

    // Not enough yet
    for (let i = 0; i < 5; i++) {
      metrics.increment("action.executed", { action: "create", status: "failed" });
    }
    let results = engine.evaluateAll();
    expect(results[0].triggered).toBe(false);
    expect(firedAlerts.length).toBe(0);

    // Now exceed threshold
    metrics.increment("action.executed", { action: "create", status: "failed" });
    results = engine.evaluateAll();
    expect(results[0].triggered).toBe(true);
    expect(results[0].actualValue).toBe(6);
    expect(firedAlerts.length).toBe(1);
    expect(firedAlerts[0].severity).toBe("warning");
  });

  it("evaluates alerts against gauge metrics", () => {
    const engine = new AlertEngine({
      metrics,
      onAlert: (r) => firedAlerts.push(r),
    });

    engine.register(
      defineSystemAlert({
        name: "queue_backlog",
        condition: { metric: "outbox.pending", operator: "gt", value: 100 },
        effect: { notify: ["ops"], severity: "critical" },
      }),
    );

    metrics.gauge("outbox.pending", 50);
    engine.evaluateAll();
    expect(firedAlerts.length).toBe(0);

    metrics.gauge("outbox.pending", 150);
    engine.evaluateAll();
    expect(firedAlerts.length).toBe(1);
    expect(firedAlerts[0].alert).toBe("queue_backlog");
  });

  it("evaluates alerts against histogram percentiles", () => {
    const engine = new AlertEngine({
      metrics,
      onAlert: (r) => firedAlerts.push(r),
    });

    engine.register(
      defineSystemAlert({
        name: "slow_p95",
        condition: {
          metric: "action.duration_ms",
          operator: "gt",
          value: 500,
          percentile: "p95",
        },
        effect: { notify: ["admin"] },
      }),
    );

    // Add fast requests
    for (let i = 0; i < 100; i++) {
      metrics.histogram("action.duration_ms", 100 + i);
    }

    engine.evaluateAll();
    expect(firedAlerts.length).toBe(0);

    // Add slow requests to push p95 over 500
    for (let i = 0; i < 200; i++) {
      metrics.histogram("action.duration_ms", 600 + i);
    }

    engine.evaluateAll();
    expect(firedAlerts.length).toBe(1);
  });

  it("fires handler only on rising edge (not repeated)", () => {
    const engine = new AlertEngine({
      metrics,
      onAlert: (r) => firedAlerts.push(r),
    });

    engine.register(
      defineSystemAlert({
        name: "test_alert",
        condition: { metric: "errors", operator: "gt", value: 0 },
        effect: { notify: ["admin"] },
      }),
    );

    metrics.increment("errors");

    // First evaluation — fires
    engine.evaluateAll();
    expect(firedAlerts.length).toBe(1);

    // Second evaluation — still triggered but not re-fired
    engine.evaluateAll();
    expect(firedAlerts.length).toBe(1);
  });

  it("supports all comparison operators", () => {
    const operators: Array<{
      op: "gt" | "gte" | "lt" | "lte" | "eq" | "neq";
      val: number;
      expect: boolean;
    }> = [
      { op: "gt", val: 5, expect: true },
      { op: "gte", val: 10, expect: true },
      { op: "lt", val: 15, expect: true },
      { op: "lte", val: 10, expect: true },
      { op: "eq", val: 10, expect: true },
      { op: "neq", val: 5, expect: true },
    ];

    for (const { op, val, expect: expected } of operators) {
      const m = new InMemoryMetricsCollector();
      const engine = new AlertEngine({ metrics: m });

      m.gauge("test_metric", 10);
      engine.register(
        defineSystemAlert({
          name: `test_${op}`,
          condition: { metric: "test_metric", operator: op, value: val },
          effect: { notify: [] },
        }),
      );

      const results = engine.evaluateAll();
      expect(results[0].triggered).toBe(expected);
    }
  });

  it("skips disabled alerts", () => {
    const engine = new AlertEngine({ metrics });

    engine.register(
      defineSystemAlert({
        name: "disabled_alert",
        enabled: false,
        condition: { metric: "errors", operator: "gt", value: 0 },
        effect: { notify: ["admin"] },
      }),
    );

    metrics.increment("errors");
    const results = engine.evaluateAll();
    expect(results.length).toBe(0);
  });

  it("supports list and unregister", () => {
    const engine = new AlertEngine({ metrics });

    engine.register(
      defineSystemAlert({
        name: "a1",
        condition: { metric: "x", operator: "gt", value: 0 },
        effect: { notify: [] },
      }),
    );
    engine.register(
      defineSystemAlert({
        name: "a2",
        condition: { metric: "y", operator: "gt", value: 0 },
        effect: { notify: [] },
      }),
    );

    expect(engine.list().length).toBe(2);

    engine.unregister("a1");
    expect(engine.list().length).toBe(1);
    expect(engine.list()[0].name).toBe("a2");
  });
});

// ── CommandLayer trace propagation ──────────────────────

describe("CommandLayer trace propagation", () => {
  it("sets traceId on CommandContext during pipeline execution", async () => {
    const dp = createTestDataProvider();
    const executor = createActionExecutor({ dataProvider: dp });
    let capturedTraceId: string | undefined;

    const action: ActionDefinition = {
      name: "trace_test",
      schema: "test",
      label: "Trace Test",
      policy: { mode: "sync", transaction: false },
      exposure: "all",
      handler: async () => {
        const trace = getCurrentTrace();
        capturedTraceId = trace?.traceId;
        return { ok: true };
      },
    };
    executor.registry.register(action);

    const layer = createCommandLayer({ executor });

    // Spy on the trace through a pre middleware
    let ctxTraceId: string | undefined;
    layer.use({
      name: "trace_spy",
      slot: "pre",
      handler: async (ctx, next) => {
        ctxTraceId = ctx.traceId;
        await next();
      },
    });

    const result = await layer.execute({ command: "trace_test", input: {} });
    expect(result.success).toBe(true);

    // Both the context and the handler should see the same trace
    expect(ctxTraceId).toBeDefined();
    expect(capturedTraceId).toBeDefined();
    expect(typeof ctxTraceId).toBe("string");
  });

  it("records command.duration_ms timing", async () => {
    const metrics = new InMemoryMetricsCollector();
    const dp = createTestDataProvider();
    const executor = createActionExecutor({ dataProvider: dp });

    const action: ActionDefinition = {
      name: "timed_action",
      schema: "test",
      label: "Timed",
      policy: { mode: "sync", transaction: false },
      exposure: "all",
      handler: async () => {
        await new Promise((r) => setTimeout(r, 5));
        return { ok: true };
      },
    };
    executor.registry.register(action);

    const layer = createCommandLayer({ executor, metrics });
    await layer.execute({ command: "timed_action", input: {} });

    const durations = metrics.getHistogramValues("command.duration_ms");
    expect(durations.length).toBe(1);
    expect(durations[0]).toBeGreaterThanOrEqual(0);
  });
});

// ── Rule engine enhanced metrics ─────────────────────────

describe("Rule engine enhanced metrics", () => {
  const defaultInput: RuleEvalInput = {
    target: { amount: 5000 },
    actor: testActor,
  };

  it("records rule.evaluation_duration_ms timing", async () => {
    const metrics = new InMemoryMetricsCollector();

    const rules: RuleDefinition[] = [
      {
        name: "duration_test",
        label: "Duration Test",
        trigger: { action: "submit" },
        condition: { field: "target.amount", operator: "gt", value: 1000 },
        effect: { type: "warn", message: "High amount" },
      },
    ];

    await evaluateRules(rules, defaultInput, { metrics });

    const durations = metrics.getHistogramValues("rule.evaluation_duration_ms");
    expect(durations.length).toBe(1);
    expect(durations[0]).toBeGreaterThanOrEqual(0);
  });

  it("increments rule.block_count for blocking rules", async () => {
    const metrics = new InMemoryMetricsCollector();

    const rules: RuleDefinition[] = [
      {
        name: "blocker",
        label: "Blocker",
        trigger: { action: "submit" },
        condition: { field: "target.amount", operator: "gt", value: 1000 },
        effect: { type: "block", reason: "Too high" },
      },
    ];

    await evaluateRules(rules, defaultInput, { metrics });

    expect(metrics.getCounter("rule.block_count", { rule: "blocker" })).toBe(1);
  });

  it("does not increment rule.block_count for non-blocking rules", async () => {
    const metrics = new InMemoryMetricsCollector();

    const rules: RuleDefinition[] = [
      {
        name: "warner",
        label: "Warner",
        trigger: { action: "submit" },
        condition: { field: "target.amount", operator: "gt", value: 1000 },
        effect: { type: "warn", message: "High" },
      },
    ];

    await evaluateRules(rules, defaultInput, { metrics });

    expect(metrics.getCounter("rule.block_count", { rule: "warner" })).toBe(0);
  });
});
