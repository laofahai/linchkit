/**
 * Metrics integration tests — verify metrics are collected at runtime
 * when a MetricsCollector is wired into engines.
 */

import { describe, expect, it, beforeEach } from "bun:test";
import { createActionExecutor, type DataProvider } from "../src/engine/action-engine";
import { createCommandLayer } from "../src/engine/command-layer";
import { evaluateRules, type RuleEvalInput } from "../src/engine/rule-engine";
import { createEventBus } from "../src/event/event-bus";
import { InMemoryMetricsCollector } from "../src/observability/metrics";
import type { ActionDefinition, Actor } from "../src/types/action";
import type { EventRecord } from "../src/types/event";
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
      data.get(schema)!.set(id, record);
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

// ── ActionExecutor metrics ────────────────────────────────

describe("ActionExecutor metrics", () => {
  let metrics: InMemoryMetricsCollector;

  beforeEach(() => {
    metrics = new InMemoryMetricsCollector();
  });

  it("increments action.executed counter on success", async () => {
    const dp = createTestDataProvider();
    const executor = createActionExecutor({ dataProvider: dp, metrics });

    const action: ActionDefinition = {
      name: "create_order",
      schema: "order",
      label: "Create Order",
      policy: { mode: "sync", transaction: false },
      handler: async (ctx) => ctx.create("order", ctx.input),
    };
    executor.registry.register(action);

    const result = await executor.execute("create_order", { title: "Test" }, testActor);
    expect(result.success).toBe(true);

    expect(metrics.getCounter("action.executed", {
      action: "create_order",
      schema: "order",
      status: "succeeded",
    })).toBe(1);
  });

  it("records action.duration_ms timing on success", async () => {
    const dp = createTestDataProvider();
    const executor = createActionExecutor({ dataProvider: dp, metrics });

    const action: ActionDefinition = {
      name: "slow_action",
      schema: "order",
      label: "Slow Action",
      policy: { mode: "sync", transaction: false },
      handler: async () => {
        await new Promise((r) => setTimeout(r, 10));
        return { ok: true };
      },
    };
    executor.registry.register(action);

    await executor.execute("slow_action", {}, testActor);

    const durations = metrics.getHistogramValues("action.duration_ms");
    expect(durations.length).toBe(1);
    expect(durations[0]).toBeGreaterThanOrEqual(5);
  });

  it("increments action.executed with failed status on handler error", async () => {
    const dp = createTestDataProvider();
    const executor = createActionExecutor({ dataProvider: dp, metrics });

    const action: ActionDefinition = {
      name: "failing_action",
      schema: "order",
      label: "Failing Action",
      policy: { mode: "sync", transaction: false },
      handler: async () => {
        throw new Error("Boom");
      },
    };
    executor.registry.register(action);

    const result = await executor.execute("failing_action", {}, testActor);
    expect(result.success).toBe(false);

    expect(metrics.getCounter("action.executed", {
      action: "failing_action",
      schema: "order",
      status: "failed",
    })).toBe(1);
  });
});

// ── CommandLayer metrics ─────────────────────────────────

describe("CommandLayer metrics", () => {
  it("increments command.processed counter", async () => {
    const metrics = new InMemoryMetricsCollector();
    const dp = createTestDataProvider();
    const executor = createActionExecutor({ dataProvider: dp });

    const action: ActionDefinition = {
      name: "create_item",
      schema: "item",
      label: "Create Item",
      policy: { mode: "sync", transaction: false },
      exposure: "all",
      handler: async (ctx) => ctx.create("item", ctx.input),
    };
    executor.registry.register(action);

    const layer = createCommandLayer({ executor, metrics });

    await layer.execute({ command: "create_item", input: { name: "test" } });

    expect(metrics.getCounter("command.processed", { command: "create_item", status: "succeeded" })).toBe(1);
  });
});

// ── EventBus metrics ─────────────────────────────────────

describe("EventBus metrics", () => {
  it("increments event.emitted counter on emit", async () => {
    const metrics = new InMemoryMetricsCollector();
    const { registry, bus } = createEventBus({ metrics });

    registry.register({
      name: "noop-handler",
      listen: "order.created",
      handler: async () => {},
    });

    const event: EventRecord = {
      id: crypto.randomUUID(),
      type: "order.created",
      category: "runtime",
      timestamp: new Date(),
      actor: { type: "system", id: "test" },
      executionId: crypto.randomUUID(),
      payload: {},
    };

    await bus.emit(event);

    expect(metrics.getCounter("event.emitted", { eventType: "order.created" })).toBe(1);
  });

  it("tracks multiple event types independently", async () => {
    const metrics = new InMemoryMetricsCollector();
    const { bus } = createEventBus({ metrics });

    const makeEvent = (type: string): EventRecord => ({
      id: crypto.randomUUID(),
      type,
      category: "runtime",
      timestamp: new Date(),
      actor: { type: "system", id: "test" },
      executionId: crypto.randomUUID(),
      payload: {},
    });

    await bus.emit(makeEvent("order.created"));
    await bus.emit(makeEvent("order.created"));
    await bus.emit(makeEvent("order.updated"));

    expect(metrics.getCounter("event.emitted", { eventType: "order.created" })).toBe(2);
    expect(metrics.getCounter("event.emitted", { eventType: "order.updated" })).toBe(1);
  });
});

// ── Rule engine metrics ──────────────────────────────────

describe("evaluateRules metrics", () => {
  const defaultInput: RuleEvalInput = {
    target: { amount: 5000 },
    actor: { type: "human", id: "user-1", groups: ["employee"] },
  };

  it("increments rule.evaluated for each rule", async () => {
    const metrics = new InMemoryMetricsCollector();

    const rules: RuleDefinition[] = [
      {
        name: "high-amount-warn",
        label: "High Amount Warning",
        trigger: { action: "submit" },
        condition: { field: "target.amount", operator: "gt", value: 1000 },
        effect: { type: "warn", message: "High amount" },
      },
      {
        name: "low-amount-check",
        label: "Low Amount Check",
        trigger: { action: "submit" },
        condition: { field: "target.amount", operator: "lt", value: 100 },
        effect: { type: "warn", message: "Low amount" },
      },
    ];

    await evaluateRules(rules, defaultInput, { metrics });

    // First rule triggers (amount 5000 > 1000)
    expect(metrics.getCounter("rule.evaluated", {
      rule: "high-amount-warn",
      effect: "warn",
    })).toBe(1);

    // Second rule also evaluated but not triggered (amount 5000 is not < 100)
    expect(metrics.getCounter("rule.evaluated", {
      rule: "low-amount-check",
      effect: "none",
    })).toBe(1);
  });

  it("records block effect type for blocking rules", async () => {
    const metrics = new InMemoryMetricsCollector();

    const rules: RuleDefinition[] = [
      {
        name: "block-rule",
        label: "Block Rule",
        trigger: { action: "submit" },
        condition: { field: "target.amount", operator: "gt", value: 1000 },
        effect: { type: "block", reason: "Amount too high" },
      },
    ];

    await evaluateRules(rules, defaultInput, { metrics });

    expect(metrics.getCounter("rule.evaluated", {
      rule: "block-rule",
      effect: "block",
    })).toBe(1);
  });
});
