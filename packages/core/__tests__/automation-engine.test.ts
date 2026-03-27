import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type AutomationActionExecutor,
  type AutomationEngine,
  type AutomationFlowStarter,
  type AutomationNotifier,
  createAutomationEngine,
} from "../src/automation/automation-engine";
import {
  type AutomationRegistry,
  createAutomationRegistry,
} from "../src/automation/automation-registry";
import type { EventBusLike } from "../src/flow/trigger-binding";
import type { AutomationDefinition } from "../src/types/automation";
import type { EventRecord } from "../src/types/event";

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

function createMockFlowStarter(): AutomationFlowStarter & {
  calls: Array<{ flowName: string; input: Record<string, unknown> }>;
} {
  const calls: Array<{ flowName: string; input: Record<string, unknown> }> = [];
  return {
    calls,
    async startFlow(flowName, input) {
      calls.push({ flowName, input });
      return { ok: true };
    },
  };
}

function createMockNotifier(): AutomationNotifier & {
  calls: Array<{ channel: string; message: string }>;
} {
  const calls: Array<{ channel: string; message: string }> = [];
  return {
    calls,
    async notify(channel, message) {
      calls.push({ channel, message });
    },
  };
}

// ── Test fixtures ───────────────────────────────────────

const eventAutomation: AutomationDefinition = {
  name: "on-order-created",
  description: "Send notification when order is created",
  trigger: {
    type: "event",
    eventType: "order.created",
  },
  actions: [{ type: "send_notification", channel: "email", message: "New order created" }],
  enabled: true,
};

const filteredEventAutomation: AutomationDefinition = {
  name: "on-large-order",
  description: "Start approval flow for large orders",
  trigger: {
    type: "event",
    eventType: "order.created",
    filter: { field: "target.amount", operator: "gt", value: 10000 },
  },
  actions: [{ type: "start_flow", flow: "approval-flow", input: { reason: "large order" } }],
  enabled: true,
};

const fieldChangeAutomation: AutomationDefinition = {
  name: "on-priority-change",
  description: "Notify when priority changes to high",
  trigger: {
    type: "fieldChange",
    schema: "ticket",
    field: "priority",
    to: "high",
  },
  actions: [
    { type: "send_notification", channel: "slack", message: "Ticket escalated to high priority" },
  ],
  enabled: true,
};

const stateChangeAutomation: AutomationDefinition = {
  name: "on-approved",
  description: "Execute fulfillment when order is approved",
  trigger: {
    type: "stateChange",
    schema: "order",
    from: "pending",
    to: "approved",
  },
  actions: [{ type: "execute_action", action: "order.fulfill", input: { urgent: false } }],
  enabled: true,
};

const multiActionAutomation: AutomationDefinition = {
  name: "multi-action",
  trigger: { type: "event", eventType: "test.event" },
  actions: [
    { type: "execute_action", action: "action1", input: {} },
    { type: "execute_action", action: "action2", input: {} },
    { type: "send_notification", channel: "log", message: "done" },
  ],
  enabled: true,
};

// ── Tests ───────────────────────────────────────────────

describe("AutomationRegistry", () => {
  let registry: AutomationRegistry;

  beforeEach(() => {
    registry = createAutomationRegistry();
  });

  it("registers and retrieves automations", () => {
    registry.register(eventAutomation);
    expect(registry.has("on-order-created")).toBe(true);
    expect(registry.get("on-order-created")?.description).toBe(
      "Send notification when order is created",
    );
  });

  it("throws on duplicate registration", () => {
    registry.register(eventAutomation);
    expect(() => registry.register(eventAutomation)).toThrow("already registered");
  });

  it("returns all automations", () => {
    registry.register(eventAutomation);
    registry.register(fieldChangeAutomation);
    expect(registry.getAll()).toHaveLength(2);
  });

  it("filters enabled automations", () => {
    registry.register(eventAutomation);
    registry.register({ ...fieldChangeAutomation, enabled: false });
    expect(registry.getEnabled()).toHaveLength(1);
    expect(registry.getEnabled()[0]?.name).toBe("on-order-created");
  });

  it("enables and disables automations", () => {
    registry.register(eventAutomation);
    registry.disable("on-order-created");
    expect(registry.getEnabled()).toHaveLength(0);
    registry.enable("on-order-created");
    expect(registry.getEnabled()).toHaveLength(1);
  });

  it("removes automations", () => {
    registry.register(eventAutomation);
    expect(registry.remove("on-order-created")).toBe(true);
    expect(registry.has("on-order-created")).toBe(false);
    expect(registry.remove("nonexistent")).toBe(false);
  });
});

describe("AutomationEngine — event triggers", () => {
  let registry: AutomationRegistry;
  let bus: ReturnType<typeof createMockEventBus>;
  let notifier: ReturnType<typeof createMockNotifier>;
  let engine: AutomationEngine;

  beforeEach(() => {
    registry = createAutomationRegistry();
    bus = createMockEventBus();
    notifier = createMockNotifier();
  });

  afterEach(() => {
    engine?.stop();
  });

  it("subscribes to event bus and triggers on matching event", async () => {
    registry.register(eventAutomation);
    engine = createAutomationEngine({ registry, eventBus: bus, notifier });
    engine.start();

    await bus.emit("order.created", makeEvent("order.created", { orderId: "123" }));

    expect(notifier.calls).toHaveLength(1);
    expect(notifier.calls[0]?.channel).toBe("email");
  });

  it("does not trigger when automation is disabled", async () => {
    registry.register({ ...eventAutomation, enabled: false });
    engine = createAutomationEngine({ registry, eventBus: bus, notifier });
    engine.start();

    await bus.emit("order.created", makeEvent("order.created", {}));

    expect(notifier.calls).toHaveLength(0);
  });

  it("does not trigger disabled automations checked at runtime", async () => {
    registry.register(eventAutomation);
    engine = createAutomationEngine({ registry, eventBus: bus, notifier });
    engine.start();

    // Disable after start
    registry.disable("on-order-created");

    await bus.emit("order.created", makeEvent("order.created", {}));

    expect(notifier.calls).toHaveLength(0);
  });

  it("applies declarative filter to event payload", async () => {
    registry.register(filteredEventAutomation);
    const flowStarter = createMockFlowStarter();
    engine = createAutomationEngine({ registry, eventBus: bus, flowStarter });
    engine.start();

    // Amount below threshold — should not trigger
    await bus.emit("order.created", makeEvent("order.created", { amount: 5000 }));
    expect(flowStarter.calls).toHaveLength(0);

    // Amount above threshold — should trigger
    await bus.emit("order.created", makeEvent("order.created", { amount: 15000 }));
    expect(flowStarter.calls).toHaveLength(1);
    expect(flowStarter.calls[0]?.flowName).toBe("approval-flow");
  });

  it("does not trigger on unrelated event types", async () => {
    registry.register(eventAutomation);
    engine = createAutomationEngine({ registry, eventBus: bus, notifier });
    engine.start();

    await bus.emit("order.deleted", makeEvent("order.deleted", {}));

    expect(notifier.calls).toHaveLength(0);
  });
});

describe("AutomationEngine — field change triggers", () => {
  let registry: AutomationRegistry;
  let bus: ReturnType<typeof createMockEventBus>;
  let notifier: ReturnType<typeof createMockNotifier>;
  let engine: AutomationEngine;

  beforeEach(() => {
    registry = createAutomationRegistry();
    bus = createMockEventBus();
    notifier = createMockNotifier();
  });

  afterEach(() => {
    engine?.stop();
  });

  it("triggers when watched field changes to target value", async () => {
    registry.register(fieldChangeAutomation);
    engine = createAutomationEngine({ registry, eventBus: bus, notifier });
    engine.start();

    await bus.emit(
      "record.updated",
      makeEvent(
        "record.updated",
        {
          _old: { priority: "low" },
          _new: { priority: "high" },
        },
        { schema: "ticket" },
      ),
    );

    expect(notifier.calls).toHaveLength(1);
    expect(notifier.calls[0]?.message).toContain("high priority");
  });

  it("does not trigger when field changes to wrong value", async () => {
    registry.register(fieldChangeAutomation);
    engine = createAutomationEngine({ registry, eventBus: bus, notifier });
    engine.start();

    await bus.emit(
      "record.updated",
      makeEvent(
        "record.updated",
        {
          _old: { priority: "low" },
          _new: { priority: "medium" },
        },
        { schema: "ticket" },
      ),
    );

    expect(notifier.calls).toHaveLength(0);
  });

  it("does not trigger when schema does not match", async () => {
    registry.register(fieldChangeAutomation);
    engine = createAutomationEngine({ registry, eventBus: bus, notifier });
    engine.start();

    await bus.emit(
      "record.updated",
      makeEvent(
        "record.updated",
        {
          _old: { priority: "low" },
          _new: { priority: "high" },
        },
        { schema: "other_schema" },
      ),
    );

    expect(notifier.calls).toHaveLength(0);
  });

  it("does not trigger when field has not changed", async () => {
    registry.register(fieldChangeAutomation);
    engine = createAutomationEngine({ registry, eventBus: bus, notifier });
    engine.start();

    await bus.emit(
      "record.updated",
      makeEvent(
        "record.updated",
        {
          _old: { priority: "high" },
          _new: { priority: "high" },
        },
        { schema: "ticket" },
      ),
    );

    expect(notifier.calls).toHaveLength(0);
  });
});

describe("AutomationEngine — state change triggers", () => {
  let registry: AutomationRegistry;
  let bus: ReturnType<typeof createMockEventBus>;
  let actionExecutor: ReturnType<typeof createMockActionExecutor>;
  let engine: AutomationEngine;

  beforeEach(() => {
    registry = createAutomationRegistry();
    bus = createMockEventBus();
    actionExecutor = createMockActionExecutor();
  });

  afterEach(() => {
    engine?.stop();
  });

  it("triggers when state transitions match from/to", async () => {
    registry.register(stateChangeAutomation);
    engine = createAutomationEngine({ registry, eventBus: bus, actionExecutor });
    engine.start();

    await bus.emit(
      "record.updated",
      makeEvent(
        "record.updated",
        {
          _old: { _state: "pending" },
          _new: { _state: "approved" },
        },
        { schema: "order" },
      ),
    );

    expect(actionExecutor.calls).toHaveLength(1);
    expect(actionExecutor.calls[0]?.actionName).toBe("order.fulfill");
  });

  it("does not trigger when from state does not match", async () => {
    registry.register(stateChangeAutomation);
    engine = createAutomationEngine({ registry, eventBus: bus, actionExecutor });
    engine.start();

    await bus.emit(
      "record.updated",
      makeEvent(
        "record.updated",
        {
          _old: { _state: "draft" },
          _new: { _state: "approved" },
        },
        { schema: "order" },
      ),
    );

    expect(actionExecutor.calls).toHaveLength(0);
  });

  it("does not trigger when to state does not match", async () => {
    registry.register(stateChangeAutomation);
    engine = createAutomationEngine({ registry, eventBus: bus, actionExecutor });
    engine.start();

    await bus.emit(
      "record.updated",
      makeEvent(
        "record.updated",
        {
          _old: { _state: "pending" },
          _new: { _state: "rejected" },
        },
        { schema: "order" },
      ),
    );

    expect(actionExecutor.calls).toHaveLength(0);
  });
});

describe("AutomationEngine — multi-action execution", () => {
  let registry: AutomationRegistry;
  let bus: ReturnType<typeof createMockEventBus>;
  let engine: AutomationEngine;

  afterEach(() => {
    engine?.stop();
  });

  it("executes all actions in sequence", async () => {
    registry = createAutomationRegistry();
    bus = createMockEventBus();
    const actionExecutor = createMockActionExecutor();
    const notifier = createMockNotifier();

    registry.register(multiActionAutomation);
    engine = createAutomationEngine({ registry, eventBus: bus, actionExecutor, notifier });
    engine.start();

    await bus.emit("test.event", makeEvent("test.event", {}));

    expect(actionExecutor.calls).toHaveLength(2);
    expect(actionExecutor.calls[0]?.actionName).toBe("action1");
    expect(actionExecutor.calls[1]?.actionName).toBe("action2");
    expect(notifier.calls).toHaveLength(1);
  });

  it("stops execution on first failure", async () => {
    registry = createAutomationRegistry();
    bus = createMockEventBus();
    const notifier = createMockNotifier();

    const failingExecutor: AutomationActionExecutor = {
      async executeAction(actionName) {
        if (actionName === "action1") throw new Error("action1 failed");
        return {};
      },
    };

    registry.register(multiActionAutomation);
    engine = createAutomationEngine({
      registry,
      eventBus: bus,
      actionExecutor: failingExecutor,
      notifier,
    });
    engine.start();

    await bus.emit("test.event", makeEvent("test.event", {}));

    // action1 fails, so action2 and notification should NOT execute
    expect(notifier.calls).toHaveLength(0);
  });
});

describe("AutomationEngine — manual trigger", () => {
  it("executes automation manually by name", async () => {
    const registry = createAutomationRegistry();
    const bus = createMockEventBus();
    const notifier = createMockNotifier();

    registry.register(eventAutomation);
    const engine = createAutomationEngine({ registry, eventBus: bus, notifier });

    const result = await engine.triggerManually("on-order-created", { test: true });

    expect(result.success).toBe(true);
    expect(result.automation).toBe("on-order-created");
    expect(result.actionResults).toHaveLength(1);
    expect(notifier.calls).toHaveLength(1);

    engine.stop();
  });

  it("returns failure for non-existent automation", async () => {
    const registry = createAutomationRegistry();
    const bus = createMockEventBus();
    const engine = createAutomationEngine({ registry, eventBus: bus });

    const result = await engine.triggerManually("nonexistent", {});

    expect(result.success).toBe(false);
    expect(result.actionResults).toHaveLength(0);

    engine.stop();
  });
});

describe("AutomationEngine — start/stop lifecycle", () => {
  it("stop removes all subscriptions", async () => {
    const registry = createAutomationRegistry();
    const bus = createMockEventBus();
    const notifier = createMockNotifier();

    registry.register(eventAutomation);
    const engine = createAutomationEngine({ registry, eventBus: bus, notifier });

    engine.start();
    expect(bus.handlers.get("order.created")?.length).toBe(1);

    engine.stop();

    // After stop, handler should be removed
    expect(bus.handlers.get("order.created")?.length).toBe(0);

    // Events after stop should not trigger
    await bus.emit("order.created", makeEvent("order.created", {}));
    expect(notifier.calls).toHaveLength(0);
  });

  it("start is idempotent", () => {
    const registry = createAutomationRegistry();
    const bus = createMockEventBus();

    registry.register(eventAutomation);
    const engine = createAutomationEngine({ registry, eventBus: bus });

    engine.start();
    engine.start(); // Should not double-subscribe

    expect(bus.handlers.get("order.created")?.length).toBe(1);

    engine.stop();
  });
});

describe("AutomationEngine — event payload merging", () => {
  it("merges event payload as _event in action input", async () => {
    const registry = createAutomationRegistry();
    const bus = createMockEventBus();
    const actionExecutor = createMockActionExecutor();

    const automation: AutomationDefinition = {
      name: "test-merge",
      trigger: { type: "event", eventType: "test.event" },
      actions: [{ type: "execute_action", action: "my_action", input: { static: "value" } }],
      enabled: true,
    };

    registry.register(automation);
    const engine = createAutomationEngine({ registry, eventBus: bus, actionExecutor });
    engine.start();

    await bus.emit("test.event", makeEvent("test.event", { dynamic: "data" }));

    expect(actionExecutor.calls).toHaveLength(1);
    expect(actionExecutor.calls[0]?.input).toEqual({
      static: "value",
      _event: { dynamic: "data" },
    });

    engine.stop();
  });
});

describe("AutomationEngine — schedule triggers", () => {
  it("binds a valid cron schedule without error", () => {
    const registry = createAutomationRegistry();
    const bus = createMockEventBus();

    const scheduleAutomation: AutomationDefinition = {
      name: "scheduled-cleanup",
      trigger: { type: "schedule", cron: "* * * * *" },
      actions: [{ type: "execute_action", action: "cleanup", input: {} }],
      enabled: true,
    };

    registry.register(scheduleAutomation);
    const engine = createAutomationEngine({ registry, eventBus: bus });

    // Should not throw
    engine.start();
    engine.stop();
  });

  it("logs warning for invalid cron expression without crashing", () => {
    const registry = createAutomationRegistry();
    const bus = createMockEventBus();
    const warnings: string[] = [];

    const badSchedule: AutomationDefinition = {
      name: "bad-schedule",
      trigger: { type: "schedule", cron: "not-a-cron" },
      actions: [{ type: "execute_action", action: "test", input: {} }],
      enabled: true,
    };

    registry.register(badSchedule);
    const engine = createAutomationEngine({
      registry,
      eventBus: bus,
      logger: {
        debug() {},
        info() {},
        warn(msg: string) {
          warnings.push(msg);
        },
        error() {},
      },
    });

    // Should not throw
    engine.start();
    expect(warnings.some((w) => w.includes("Invalid cron"))).toBe(true);
    engine.stop();
  });

  it("stop() cleans up cron jobs without lingering timers", () => {
    const registry = createAutomationRegistry();
    const bus = createMockEventBus();

    const scheduleAutomation: AutomationDefinition = {
      name: "periodic-task",
      trigger: { type: "schedule", cron: "*/5 * * * *" },
      actions: [{ type: "execute_action", action: "ping", input: {} }],
      enabled: true,
    };

    registry.register(scheduleAutomation);
    const engine = createAutomationEngine({ registry, eventBus: bus });

    engine.start();
    // Stopping should clean up — no errors, no lingering timers
    engine.stop();
    // A second stop should be safe (idempotent)
    engine.stop();
  });
});

describe("defineAutomation", () => {
  it("sets enabled to true by default", async () => {
    // Import dynamically to test the define function
    const { defineAutomation } = await import("../src/define");

    const automation = defineAutomation({
      name: "test",
      trigger: { type: "event", eventType: "test" },
      actions: [],
    });

    expect(automation.enabled).toBe(true);
  });

  it("respects explicit enabled: false", async () => {
    const { defineAutomation } = await import("../src/define");

    const automation = defineAutomation({
      name: "test",
      trigger: { type: "event", eventType: "test" },
      actions: [],
      enabled: false,
    });

    expect(automation.enabled).toBe(false);
  });
});
