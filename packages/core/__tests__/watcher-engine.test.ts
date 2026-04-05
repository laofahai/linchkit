import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type AutomationActionExecutor,
  createWatcherEngine,
  evaluateComparison,
  parseDuration,
  type WatcherEngine,
} from "../src/automation";
import { createWatcherRegistry, type WatcherRegistry } from "../src/automation/watcher-registry";
import { defineWatcher } from "../src/define";
import type { EventBusLike, EventRecord } from "../src/types/event";
import type { WatcherDefinition } from "../src/types/watcher";

// ── Mock factories ──────────────────────────────────────

function createMockEventBus(): EventBusLike & {
  handlers: Map<string, Array<(event: EventRecord) => Promise<void>>>;
  emit: (eventType: string, event: EventRecord) => Promise<void>;
} {
  const handlers = new Map<string, Array<(event: EventRecord) => Promise<void>>>();

  return {
    handlers,
    subscribe(eventType, handler) {
      if (!handlers.has(eventType)) {
        handlers.set(eventType, []);
      }
      handlers.get(eventType)?.push(handler);
      return () => {
        const arr = handlers.get(eventType);
        if (arr) {
          const idx = arr.indexOf(handler);
          if (idx >= 0) arr.splice(idx, 1);
        }
      };
    },
    async emit(eventType, event) {
      const arr = handlers.get(eventType);
      if (arr) {
        for (const h of arr) {
          await h(event);
        }
      }
    },
  };
}

function makeEvent(
  type: string,
  payload: Record<string, unknown> = {},
  extra: Partial<EventRecord> = {},
): EventRecord {
  return {
    id: crypto.randomUUID(),
    type,
    category: "runtime",
    payload,
    timestamp: new Date(),
    actor: { type: "system", id: "test" },
    executionId: `exec-${crypto.randomUUID().slice(0, 8)}`,
    ...extra,
  };
}

function createMockActionExecutor(): AutomationActionExecutor & {
  calls: Array<{ actionName: string; input: Record<string, unknown> }>;
} {
  const calls: Array<{ actionName: string; input: Record<string, unknown> }> = [];
  return {
    calls,
    async executeAction(actionName, input) {
      calls.push({ actionName, input });
      return { ok: true };
    },
  };
}

// ── parseDuration tests ─────────────────────────────────

describe("parseDuration", () => {
  it("parses hours", () => {
    expect(parseDuration("48h")).toBe(48 * 60 * 60 * 1000);
    expect(parseDuration("1h")).toBe(60 * 60 * 1000);
  });

  it("parses days", () => {
    expect(parseDuration("7d")).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("parses minutes", () => {
    expect(parseDuration("30m")).toBe(30 * 60 * 1000);
  });

  it("parses seconds", () => {
    expect(parseDuration("10s")).toBe(10 * 1000);
  });

  it("returns null for invalid input", () => {
    expect(parseDuration("invalid")).toBeNull();
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("1h30m")).toBeNull(); // compound not supported
  });
});

// ── evaluateComparison tests ────────────────────────────

describe("evaluateComparison", () => {
  it("evaluates gt", () => {
    expect(evaluateComparison(100, { gt: 50 })).toBe(true);
    expect(evaluateComparison(50, { gt: 50 })).toBe(false);
  });

  it("evaluates lt", () => {
    expect(evaluateComparison(30, { lt: 50 })).toBe(true);
    expect(evaluateComparison(50, { lt: 50 })).toBe(false);
  });

  it("evaluates gte and lte", () => {
    expect(evaluateComparison(50, { gte: 50 })).toBe(true);
    expect(evaluateComparison(50, { lte: 50 })).toBe(true);
  });

  it("evaluates eq", () => {
    expect(evaluateComparison(100, { eq: 100 })).toBe(true);
    expect(evaluateComparison(101, { eq: 100 })).toBe(false);
  });

  it("evaluates compound conditions (all must pass)", () => {
    expect(evaluateComparison(75, { gt: 50, lt: 100 })).toBe(true);
    expect(evaluateComparison(120, { gt: 50, lt: 100 })).toBe(false);
  });
});

// ── defineWatcher tests ─────────────────────────────────

describe("defineWatcher", () => {
  it("sets enabled to true by default", () => {
    const watcher = defineWatcher({
      name: "test-watcher",
      watch: { entity: "order" },
      trigger: { type: "threshold", field: "amount", condition: { gt: 100 } },
      effect: { action: "notify", params: {} },
    });

    expect(watcher.enabled).toBe(true);
    expect(watcher.tenantScoped).toBe(true);
  });

  it("respects explicit enabled: false", () => {
    const watcher = defineWatcher({
      name: "test-watcher",
      watch: { entity: "order" },
      trigger: { type: "threshold", field: "amount", condition: { gt: 100 } },
      effect: { action: "notify", params: {} },
      enabled: false,
    });

    expect(watcher.enabled).toBe(false);
  });
});

// ── WatcherRegistry tests ───────────────────────────────

describe("WatcherRegistry", () => {
  let registry: WatcherRegistry;

  const sampleWatcher: WatcherDefinition = defineWatcher({
    name: "low-stock",
    watch: { entity: "inventory" },
    trigger: { type: "threshold", field: "quantity", condition: { lt: 10 } },
    effect: { action: "reorder", params: {} },
  });

  beforeEach(() => {
    registry = createWatcherRegistry();
  });

  it("registers and retrieves watchers", () => {
    registry.register(sampleWatcher);
    expect(registry.has("low-stock")).toBe(true);
    expect(registry.get("low-stock")?.name).toBe("low-stock");
  });

  it("throws on duplicate registration", () => {
    registry.register(sampleWatcher);
    expect(() => registry.register(sampleWatcher)).toThrow("already registered");
  });

  it("returns watchers for a specific schema", () => {
    registry.register(sampleWatcher);
    registry.register(
      defineWatcher({
        name: "other-watcher",
        watch: { entity: "order" },
        trigger: { type: "threshold", field: "total", condition: { gt: 1000 } },
        effect: { action: "alert", params: {} },
      }),
    );

    expect(registry.getForEntity("inventory")).toHaveLength(1);
    expect(registry.getForEntity("order")).toHaveLength(1);
    expect(registry.getForEntity("nonexistent")).toHaveLength(0);
  });

  it("filters enabled watchers", () => {
    registry.register(sampleWatcher);
    registry.register(
      defineWatcher({
        name: "disabled-watcher",
        watch: { entity: "order" },
        trigger: { type: "threshold", field: "total", condition: { gt: 1000 } },
        effect: { action: "alert", params: {} },
        enabled: false,
      }),
    );

    expect(registry.getEnabled()).toHaveLength(1);
    expect(registry.getAll()).toHaveLength(2);
  });

  it("enables and disables watchers", () => {
    registry.register(sampleWatcher);
    registry.disable("low-stock");
    expect(registry.getEnabled()).toHaveLength(0);
    registry.enable("low-stock");
    expect(registry.getEnabled()).toHaveLength(1);
  });

  it("removes watchers", () => {
    registry.register(sampleWatcher);
    expect(registry.remove("low-stock")).toBe(true);
    expect(registry.has("low-stock")).toBe(false);
    expect(registry.remove("nonexistent")).toBe(false);
  });
});

// ── WatcherEngine — threshold triggers ──────────────────

describe("WatcherEngine — threshold triggers (single-record)", () => {
  let registry: WatcherRegistry;
  let actionExecutor: ReturnType<typeof createMockActionExecutor>;
  let engine: WatcherEngine;

  beforeEach(() => {
    registry = createWatcherRegistry();
    actionExecutor = createMockActionExecutor();
  });

  afterEach(() => {
    engine?.stop();
  });

  it("fires when field value crosses threshold", async () => {
    registry.register(
      defineWatcher({
        name: "low-stock",
        watch: { entity: "inventory" },
        trigger: { type: "threshold", field: "quantity", condition: { lt: 10 } },
        effect: { action: "reorder", params: { urgent: true } },
      }),
    );

    engine = createWatcherEngine({ registry, actionExecutor });

    const results = await engine.evaluateAfterMutation("inventory", {
      id: "item-1",
      quantity: 5,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.fired).toBe(true);
    expect(actionExecutor.calls).toHaveLength(1);
    expect(actionExecutor.calls[0]?.actionName).toBe("reorder");
  });

  it("does not fire when condition is not met", async () => {
    registry.register(
      defineWatcher({
        name: "low-stock",
        watch: { entity: "inventory" },
        trigger: { type: "threshold", field: "quantity", condition: { lt: 10 } },
        effect: { action: "reorder", params: {} },
      }),
    );

    engine = createWatcherEngine({ registry, actionExecutor });

    const results = await engine.evaluateAfterMutation("inventory", {
      id: "item-1",
      quantity: 50,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.fired).toBe(false);
    expect(actionExecutor.calls).toHaveLength(0);
  });

  it("does not fire for unrelated schema", async () => {
    registry.register(
      defineWatcher({
        name: "low-stock",
        watch: { entity: "inventory" },
        trigger: { type: "threshold", field: "quantity", condition: { lt: 10 } },
        effect: { action: "reorder", params: {} },
      }),
    );

    engine = createWatcherEngine({ registry, actionExecutor });

    const results = await engine.evaluateAfterMutation("order", {
      id: "order-1",
      quantity: 1,
    });

    expect(results).toHaveLength(0);
  });

  it("applies watch filter before evaluation", async () => {
    registry.register(
      defineWatcher({
        name: "critical-low-stock",
        watch: {
          entity: "inventory",
          filter: { field: "target.category", operator: "eq", value: "critical" },
        },
        trigger: { type: "threshold", field: "quantity", condition: { lt: 10 } },
        effect: { action: "alert", params: {} },
      }),
    );

    engine = createWatcherEngine({ registry, actionExecutor });

    // Non-critical item — should not trigger even with low quantity
    const results1 = await engine.evaluateAfterMutation("inventory", {
      id: "item-1",
      quantity: 2,
      category: "normal",
    });
    expect(results1[0]?.fired).toBe(false);
    expect(results1[0]?.reason).toBe("filter_not_matched");

    // Critical item with low quantity — should trigger
    const results2 = await engine.evaluateAfterMutation("inventory", {
      id: "item-2",
      quantity: 2,
      category: "critical",
    });
    expect(results2[0]?.fired).toBe(true);
    expect(actionExecutor.calls).toHaveLength(1);
  });

  it("passes dynamic params function with WatcherContext", async () => {
    registry.register(
      defineWatcher({
        name: "low-stock-dynamic",
        watch: { entity: "inventory" },
        trigger: { type: "threshold", field: "quantity", condition: { lt: 10 } },
        effect: {
          action: "reorder",
          params: (ctx) => ({
            itemId: ctx.record?.id,
            currentStock: ctx.value,
          }),
        },
      }),
    );

    engine = createWatcherEngine({ registry, actionExecutor });

    await engine.evaluateAfterMutation("inventory", {
      id: "item-42",
      quantity: 3,
    });

    expect(actionExecutor.calls).toHaveLength(1);
    // The dynamic params should include the record data
    const input = actionExecutor.calls[0]?.input;
    expect(input?.itemId).toBe("item-42");
    expect(input?.currentStock).toBe(3);
  });
});

// ── Threshold triggers with aggregation ─────────────────

describe("WatcherEngine — threshold triggers (aggregate)", () => {
  let registry: WatcherRegistry;
  let actionExecutor: ReturnType<typeof createMockActionExecutor>;
  let engine: WatcherEngine;

  beforeEach(() => {
    registry = createWatcherRegistry();
    actionExecutor = createMockActionExecutor();
  });

  afterEach(() => {
    engine?.stop();
  });

  it("fires based on aggregate sum exceeding threshold", async () => {
    registry.register(
      defineWatcher({
        name: "budget-alert",
        watch: {
          entity: "purchase_request",
          aggregate: { field: "amount", op: "sum" },
        },
        trigger: { type: "threshold", condition: { gt: 100_000 } },
        effect: { action: "notify_cfo", params: {} },
      }),
    );

    const mockQuerier = {
      async queryRecords() {
        return [
          { id: "1", amount: 50_000 },
          { id: "2", amount: 30_000 },
          { id: "3", amount: 25_000 },
        ];
      },
    };

    engine = createWatcherEngine({
      registry,
      actionExecutor,
      dataQuerier: mockQuerier,
    });

    // Sum = 105,000 > 100,000 → should fire
    const results = await engine.evaluateAfterMutation("purchase_request", {
      id: "3",
      amount: 25_000,
    });

    expect(results[0]?.fired).toBe(true);
    expect(actionExecutor.calls).toHaveLength(1);
  });

  it("does not fire when aggregate does not exceed threshold", async () => {
    registry.register(
      defineWatcher({
        name: "budget-alert",
        watch: {
          entity: "purchase_request",
          aggregate: { field: "amount", op: "sum" },
        },
        trigger: { type: "threshold", condition: { gt: 100_000 } },
        effect: { action: "notify_cfo", params: {} },
      }),
    );

    const mockQuerier = {
      async queryRecords() {
        return [
          { id: "1", amount: 30_000 },
          { id: "2", amount: 20_000 },
        ];
      },
    };

    engine = createWatcherEngine({
      registry,
      actionExecutor,
      dataQuerier: mockQuerier,
    });

    const results = await engine.evaluateAfterMutation("purchase_request", {
      id: "2",
      amount: 20_000,
    });

    expect(results[0]?.fired).toBe(false);
  });
});

// ── Debounce strategies ─────────────────────────────────

describe("WatcherEngine — debounce strategies", () => {
  let registry: WatcherRegistry;
  let actionExecutor: ReturnType<typeof createMockActionExecutor>;
  let engine: WatcherEngine;

  beforeEach(() => {
    registry = createWatcherRegistry();
    actionExecutor = createMockActionExecutor();
  });

  afterEach(() => {
    engine?.stop();
  });

  it("once_until_reset: fires once, then not again until condition resets", async () => {
    registry.register(
      defineWatcher({
        name: "low-stock-debounced",
        watch: { entity: "inventory" },
        trigger: {
          type: "threshold",
          field: "quantity",
          condition: { lt: 10 },
          debounce: "once_until_reset",
        },
        effect: { action: "reorder", params: {} },
      }),
    );

    engine = createWatcherEngine({ registry, actionExecutor });

    // First fire — should trigger
    const r1 = await engine.evaluateAfterMutation("inventory", {
      id: "item-1",
      quantity: 5,
    });
    expect(r1[0]?.fired).toBe(true);

    // Second fire with same condition — should be debounced
    const r2 = await engine.evaluateAfterMutation("inventory", {
      id: "item-1",
      quantity: 3,
    });
    expect(r2[0]?.fired).toBe(false);
    expect(r2[0]?.reason).toBe("debounced");

    // Reset condition (quantity back above threshold)
    engine.resetState("low-stock-debounced", "item-1");

    // Fire again — should trigger
    const r3 = await engine.evaluateAfterMutation("inventory", {
      id: "item-1",
      quantity: 8,
    });
    expect(r3[0]?.fired).toBe(true);

    expect(actionExecutor.calls).toHaveLength(2);
  });

  it("once_per_record: fires once per record ID, never again", async () => {
    registry.register(
      defineWatcher({
        name: "low-stock-once",
        watch: { entity: "inventory" },
        trigger: {
          type: "threshold",
          field: "quantity",
          condition: { lt: 10 },
          debounce: "once_per_record",
        },
        effect: { action: "reorder", params: {} },
      }),
    );

    engine = createWatcherEngine({ registry, actionExecutor });

    // First fire for item-1
    const r1 = await engine.evaluateAfterMutation("inventory", {
      id: "item-1",
      quantity: 5,
    });
    expect(r1[0]?.fired).toBe(true);

    // Second fire for same item — blocked
    const r2 = await engine.evaluateAfterMutation("inventory", {
      id: "item-1",
      quantity: 3,
    });
    expect(r2[0]?.fired).toBe(false);

    // Different item — should fire
    const r3 = await engine.evaluateAfterMutation("inventory", {
      id: "item-2",
      quantity: 2,
    });
    expect(r3[0]?.fired).toBe(true);

    expect(actionExecutor.calls).toHaveLength(2);
  });

  it("no debounce: fires every time condition is met", async () => {
    registry.register(
      defineWatcher({
        name: "no-debounce",
        watch: { entity: "inventory" },
        trigger: {
          type: "threshold",
          field: "quantity",
          condition: { lt: 10 },
          // No debounce set
        },
        effect: { action: "reorder", params: {} },
      }),
    );

    engine = createWatcherEngine({ registry, actionExecutor });

    await engine.evaluateAfterMutation("inventory", { id: "item-1", quantity: 5 });
    await engine.evaluateAfterMutation("inventory", { id: "item-1", quantity: 3 });
    await engine.evaluateAfterMutation("inventory", { id: "item-1", quantity: 1 });

    expect(actionExecutor.calls).toHaveLength(3);
  });
});

// ── Set-change triggers ─────────────────────────────────

describe("WatcherEngine — set_change triggers", () => {
  let registry: WatcherRegistry;
  let actionExecutor: ReturnType<typeof createMockActionExecutor>;
  let engine: WatcherEngine;

  beforeEach(() => {
    registry = createWatcherRegistry();
    actionExecutor = createMockActionExecutor();
  });

  afterEach(() => {
    engine?.stop();
  });

  it("fires on 'added' when record enters filtered set", async () => {
    registry.register(
      defineWatcher({
        name: "high-value-added",
        watch: {
          entity: "purchase_request",
          filter: { field: "target.amount", operator: "gt", value: 50_000 },
        },
        trigger: { type: "set_change", on: "added" },
        effect: { action: "notify_cfo", params: {} },
      }),
    );

    engine = createWatcherEngine({ registry, actionExecutor });

    // Record enters the set (old: amount=30k, new: amount=60k)
    const results = await engine.evaluateAfterMutation(
      "purchase_request",
      { id: "pr-1", amount: 60_000 },
      { id: "pr-1", amount: 30_000 },
    );

    expect(results[0]?.fired).toBe(true);
    expect(actionExecutor.calls).toHaveLength(1);
  });

  it("does not fire on 'added' when record was already in set", async () => {
    registry.register(
      defineWatcher({
        name: "high-value-added",
        watch: {
          entity: "purchase_request",
          filter: { field: "target.amount", operator: "gt", value: 50_000 },
        },
        trigger: { type: "set_change", on: "added" },
        effect: { action: "notify_cfo", params: {} },
      }),
    );

    engine = createWatcherEngine({ registry, actionExecutor });

    // Record was already in set (old: 60k → new: 70k)
    const results = await engine.evaluateAfterMutation(
      "purchase_request",
      { id: "pr-1", amount: 70_000 },
      { id: "pr-1", amount: 60_000 },
    );

    expect(results[0]?.fired).toBe(false);
    expect(actionExecutor.calls).toHaveLength(0);
  });

  it("fires on 'removed' when record leaves filtered set", async () => {
    registry.register(
      defineWatcher({
        name: "high-value-removed",
        watch: {
          entity: "purchase_request",
          filter: { field: "target.amount", operator: "gt", value: 50_000 },
        },
        trigger: { type: "set_change", on: "removed" },
        effect: { action: "log_removal", params: {} },
      }),
    );

    engine = createWatcherEngine({ registry, actionExecutor });

    // Record leaves the set (old: 60k → new: 30k)
    const results = await engine.evaluateAfterMutation(
      "purchase_request",
      { id: "pr-1", amount: 30_000 },
      { id: "pr-1", amount: 60_000 },
    );

    expect(results[0]?.fired).toBe(true);
  });

  it("fires on 'modified' when record is in set and data changed", async () => {
    registry.register(
      defineWatcher({
        name: "high-value-modified",
        watch: {
          entity: "purchase_request",
          filter: { field: "target.amount", operator: "gt", value: 50_000 },
        },
        trigger: { type: "set_change", on: "modified" },
        effect: { action: "log_change", params: {} },
      }),
    );

    engine = createWatcherEngine({ registry, actionExecutor });

    // Record modified while in set (old: 60k → new: 70k)
    const results = await engine.evaluateAfterMutation(
      "purchase_request",
      { id: "pr-1", amount: 70_000 },
      { id: "pr-1", amount: 60_000 },
    );

    expect(results[0]?.fired).toBe(true);
  });
});

// ── Event-bus reactive evaluation ───────────────────────

describe("WatcherEngine — event-bus reactive evaluation", () => {
  let registry: WatcherRegistry;
  let bus: ReturnType<typeof createMockEventBus>;
  let actionExecutor: ReturnType<typeof createMockActionExecutor>;
  let engine: WatcherEngine;

  beforeEach(() => {
    registry = createWatcherRegistry();
    bus = createMockEventBus();
    actionExecutor = createMockActionExecutor();
  });

  afterEach(() => {
    engine?.stop();
  });

  it("evaluates threshold watchers on record.created events", async () => {
    registry.register(
      defineWatcher({
        name: "low-stock",
        watch: { entity: "inventory" },
        trigger: { type: "threshold", field: "quantity", condition: { lt: 10 } },
        effect: { action: "reorder", params: {} },
      }),
    );

    engine = createWatcherEngine({ registry, eventBus: bus, actionExecutor });
    engine.start();

    await bus.emit(
      "record.created",
      makeEvent("record.created", { id: "item-1", quantity: 3 }, { entity: "inventory" }),
    );

    expect(actionExecutor.calls).toHaveLength(1);
    expect(actionExecutor.calls[0]?.actionName).toBe("reorder");
  });

  it("evaluates threshold watchers on record.updated events", async () => {
    registry.register(
      defineWatcher({
        name: "low-stock",
        watch: { entity: "inventory" },
        trigger: { type: "threshold", field: "quantity", condition: { lt: 10 } },
        effect: { action: "reorder", params: {} },
      }),
    );

    engine = createWatcherEngine({ registry, eventBus: bus, actionExecutor });
    engine.start();

    await bus.emit(
      "record.updated",
      makeEvent(
        "record.updated",
        {
          _old: { id: "item-1", quantity: 15 },
          _new: { id: "item-1", quantity: 5 },
        },
        { entity: "inventory" },
      ),
    );

    expect(actionExecutor.calls).toHaveLength(1);
  });

  it("does not evaluate for unrelated schema events", async () => {
    registry.register(
      defineWatcher({
        name: "low-stock",
        watch: { entity: "inventory" },
        trigger: { type: "threshold", field: "quantity", condition: { lt: 10 } },
        effect: { action: "reorder", params: {} },
      }),
    );

    engine = createWatcherEngine({ registry, eventBus: bus, actionExecutor });
    engine.start();

    await bus.emit(
      "record.created",
      makeEvent("record.created", { id: "order-1", quantity: 1 }, { entity: "order" }),
    );

    expect(actionExecutor.calls).toHaveLength(0);
  });

  it("stop removes all subscriptions", async () => {
    registry.register(
      defineWatcher({
        name: "low-stock",
        watch: { entity: "inventory" },
        trigger: { type: "threshold", field: "quantity", condition: { lt: 10 } },
        effect: { action: "reorder", params: {} },
      }),
    );

    engine = createWatcherEngine({ registry, eventBus: bus, actionExecutor });
    engine.start();
    engine.stop();

    await bus.emit(
      "record.created",
      makeEvent("record.created", { id: "item-1", quantity: 3 }, { entity: "inventory" }),
    );

    expect(actionExecutor.calls).toHaveLength(0);
  });
});

// ── Staleness evaluation ────────────────────────────────

describe("WatcherEngine — staleness triggers", () => {
  let registry: WatcherRegistry;
  let actionExecutor: ReturnType<typeof createMockActionExecutor>;
  let engine: WatcherEngine;

  afterEach(() => {
    engine?.stop();
  });

  it("fires when a record is stale beyond the threshold", async () => {
    registry = createWatcherRegistry();
    actionExecutor = createMockActionExecutor();

    registry.register(
      defineWatcher({
        name: "stale-request",
        watch: {
          entity: "purchase_request",
          filter: { field: "target.status", operator: "eq", value: "submitted" },
        },
        trigger: { type: "staleness", field: "updated_at", threshold: "48h" },
        effect: { action: "escalate", params: {} },
      }),
    );

    const staleDate = new Date(Date.now() - 72 * 60 * 60 * 1000); // 72h ago
    const freshDate = new Date(Date.now() - 12 * 60 * 60 * 1000); // 12h ago

    const mockQuerier = {
      async queryRecords() {
        return [
          { id: "req-1", status: "submitted", updated_at: staleDate },
          { id: "req-2", status: "submitted", updated_at: freshDate },
          { id: "req-3", status: "approved", updated_at: staleDate }, // filtered out by status
        ];
      },
    };

    engine = createWatcherEngine({
      registry,
      actionExecutor,
      dataQuerier: mockQuerier,
      stalenessIntervalMs: 50, // 50ms for testing
    });

    engine.start();

    // Wait for the interval to fire
    await new Promise((resolve) => setTimeout(resolve, 100));

    engine.stop();

    // Only req-1 should trigger (stale + submitted)
    expect(actionExecutor.calls).toHaveLength(1);
    expect(actionExecutor.calls[0]?.actionName).toBe("escalate");
  });
});

// ── State management ────────────────────────────────────

describe("WatcherEngine — state management", () => {
  it("getState returns state for a watcher", async () => {
    const registry = createWatcherRegistry();
    const actionExecutor = createMockActionExecutor();

    registry.register(
      defineWatcher({
        name: "test-state",
        watch: { entity: "inventory" },
        trigger: {
          type: "threshold",
          field: "quantity",
          condition: { lt: 10 },
          debounce: "once_until_reset",
        },
        effect: { action: "reorder", params: {} },
      }),
    );

    const engine = createWatcherEngine({ registry, actionExecutor });

    await engine.evaluateAfterMutation("inventory", { id: "item-1", quantity: 5 });

    const state = engine.getState("test-state", "item-1");
    expect(state).toBeDefined();
    expect(state?.conditionMet).toBe(true);
    expect(state?.lastFiredAt).toBeInstanceOf(Date);

    engine.stop();
  });

  it("resetState clears state for a watcher and groupKey", async () => {
    const registry = createWatcherRegistry();
    const actionExecutor = createMockActionExecutor();

    registry.register(
      defineWatcher({
        name: "test-reset",
        watch: { entity: "inventory" },
        trigger: {
          type: "threshold",
          field: "quantity",
          condition: { lt: 10 },
          debounce: "once_per_record",
        },
        effect: { action: "reorder", params: {} },
      }),
    );

    const engine = createWatcherEngine({ registry, actionExecutor });

    await engine.evaluateAfterMutation("inventory", { id: "item-1", quantity: 5 });
    expect(engine.getState("test-reset", "item-1")).toBeDefined();

    engine.resetState("test-reset", "item-1");
    expect(engine.getState("test-reset", "item-1")).toBeUndefined();

    engine.stop();
  });

  it("resetState without groupKey clears all state for a watcher", async () => {
    const registry = createWatcherRegistry();
    const actionExecutor = createMockActionExecutor();

    registry.register(
      defineWatcher({
        name: "test-reset-all",
        watch: { entity: "inventory" },
        trigger: {
          type: "threshold",
          field: "quantity",
          condition: { lt: 10 },
          debounce: "once_per_record",
        },
        effect: { action: "reorder", params: {} },
      }),
    );

    const engine = createWatcherEngine({ registry, actionExecutor });

    await engine.evaluateAfterMutation("inventory", { id: "item-1", quantity: 5 });
    await engine.evaluateAfterMutation("inventory", { id: "item-2", quantity: 3 });

    engine.resetState("test-reset-all");
    expect(engine.getState("test-reset-all", "item-1")).toBeUndefined();
    expect(engine.getState("test-reset-all", "item-2")).toBeUndefined();

    engine.stop();
  });
});

// ── Disabled watcher handling ───────────────────────────

describe("WatcherEngine — disabled watchers", () => {
  it("skips disabled watchers in evaluation", async () => {
    const registry = createWatcherRegistry();
    const actionExecutor = createMockActionExecutor();

    registry.register(
      defineWatcher({
        name: "disabled-watcher",
        watch: { entity: "inventory" },
        trigger: { type: "threshold", field: "quantity", condition: { lt: 10 } },
        effect: { action: "reorder", params: {} },
        enabled: false,
      }),
    );

    const engine = createWatcherEngine({ registry, actionExecutor });

    const results = await engine.evaluateAfterMutation("inventory", {
      id: "item-1",
      quantity: 5,
    });

    // Disabled watchers are not returned by getForSchema
    expect(results).toHaveLength(0);
    expect(actionExecutor.calls).toHaveLength(0);

    engine.stop();
  });
});

// ── Error handling ──────────────────────────────────────

describe("WatcherEngine — error handling", () => {
  it("catches errors from action executor and reports them", async () => {
    const registry = createWatcherRegistry();
    const failingExecutor: AutomationActionExecutor = {
      async executeAction() {
        throw new Error("action failed");
      },
    };

    registry.register(
      defineWatcher({
        name: "error-watcher",
        watch: { entity: "inventory" },
        trigger: { type: "threshold", field: "quantity", condition: { lt: 10 } },
        effect: { action: "reorder", params: {} },
      }),
    );

    const engine = createWatcherEngine({
      registry,
      actionExecutor: failingExecutor,
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    });

    const results = await engine.evaluateAfterMutation("inventory", {
      id: "item-1",
      quantity: 5,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.fired).toBe(false);
    expect(results[0]?.error).toContain("action failed");

    engine.stop();
  });
});
