import { describe, expect, it } from "bun:test";
import type { EventBusLike } from "../src/flow/trigger-binding";
import { createTriggerBinding } from "../src/flow/trigger-binding";
import type { FlowEngine } from "../src/flow/types";
import type { EventRecord } from "../src/types/event";
import type { FlowDefinition, FlowInstance } from "../src/types/flow";
import type { Logger } from "../src/types/logger";

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

function createMockFlowEngine(): FlowEngine & {
  started: Array<{ flowName: string; input: Record<string, unknown>; options?: unknown }>;
} {
  const started: Array<{ flowName: string; input: Record<string, unknown>; options?: unknown }> =
    [];

  return {
    started,
    registerFlow() {},
    async startFlow(flowName, input, options) {
      started.push({ flowName, input, options });
      return {
        id: (options as { instanceId?: string })?.instanceId ?? "test-id",
        flowName,
        status: "completed",
        currentStepId: "",
        context: {},
        startedAt: new Date(),
      } as FlowInstance;
    },
    async getFlowStatus() {
      return null;
    },
    async sendSignal() {},
    async cancelFlow() {},
  };
}

function makeEvent(id: string, type: string, payload: Record<string, unknown> = {}): EventRecord {
  return {
    id,
    type,
    category: "action",
    payload,
    timestamp: new Date(),
    actor: { type: "user", id: "test-user" },
    executionId: `exec-${id}`,
  };
}

// ── Test fixtures ───────────────────────────────────────

const eventFlow: FlowDefinition = {
  name: "on-submit",
  trigger: {
    type: "event",
    eventType: "action.succeeded",
    filter: { actionName: "purchase_request.submit" },
  },
  steps: [{ id: "s1", name: "Notify", type: "action", actionName: "notification.send" }],
};

const manualFlow: FlowDefinition = {
  name: "manual-flow",
  trigger: { type: "manual" },
  steps: [{ id: "s1", name: "Step 1", type: "action", actionName: "test.action" }],
};

const unfilteredEventFlow: FlowDefinition = {
  name: "audit-log",
  trigger: {
    type: "event",
    eventType: "action.succeeded",
  },
  steps: [{ id: "s1", name: "Log", type: "action", actionName: "audit.log" }],
};

// ── Tests ───────────────────────────────────────────────

describe("TriggerBinding", () => {
  it("subscribes event-triggered flows to the event bus", async () => {
    const bus = createMockEventBus();
    const engine = createMockFlowEngine();
    const binding = createTriggerBinding(bus);

    binding.bindAll([eventFlow], engine);

    expect(bus.handlers.get("action.succeeded")?.length).toBe(1);
  });

  it("does not subscribe manual-triggered flows", () => {
    const bus = createMockEventBus();
    const engine = createMockFlowEngine();
    const binding = createTriggerBinding(bus);

    binding.bindAll([manualFlow], engine);

    expect(bus.handlers.size).toBe(0);
  });

  it("starts a flow when a matching event fires", async () => {
    const bus = createMockEventBus();
    const engine = createMockFlowEngine();
    const binding = createTriggerBinding(bus);

    binding.bindAll([eventFlow], engine);

    await bus.emit(
      "action.succeeded",
      makeEvent("evt-1", "action.succeeded", {
        actionName: "purchase_request.submit",
        recordId: "pr-123",
      }),
    );

    expect(engine.started).toHaveLength(1);
    expect(engine.started[0]?.flowName).toBe("on-submit");
    expect(engine.started[0]?.input).toEqual({
      actionName: "purchase_request.submit",
      recordId: "pr-123",
    });
  });

  it("does not start a flow when filter does not match", async () => {
    const bus = createMockEventBus();
    const engine = createMockFlowEngine();
    const binding = createTriggerBinding(bus);

    binding.bindAll([eventFlow], engine);

    await bus.emit(
      "action.succeeded",
      makeEvent("evt-2", "action.succeeded", {
        actionName: "some_other_action",
      }),
    );

    expect(engine.started).toHaveLength(0);
  });

  it("starts a flow with no filter on any matching event type", async () => {
    const bus = createMockEventBus();
    const engine = createMockFlowEngine();
    const binding = createTriggerBinding(bus);

    binding.bindAll([unfilteredEventFlow], engine);

    await bus.emit("action.succeeded", makeEvent("evt-3", "action.succeeded", { anything: true }));

    expect(engine.started).toHaveLength(1);
    expect(engine.started[0]?.flowName).toBe("audit-log");
  });

  it("generates deterministic instance IDs from flow name + event ID", async () => {
    const bus = createMockEventBus();
    const engine = createMockFlowEngine();
    const binding = createTriggerBinding(bus);

    binding.bindAll([unfilteredEventFlow], engine);

    await bus.emit("action.succeeded", makeEvent("evt-42", "action.succeeded", {}));

    const opts = engine.started[0]?.options as { instanceId?: string };
    expect(opts?.instanceId).toBe("audit-log-evt-42");
  });

  it("passes event tenantId and actor to the flow engine", async () => {
    const bus = createMockEventBus();
    const engine = createMockFlowEngine();
    const binding = createTriggerBinding(bus);

    binding.bindAll([unfilteredEventFlow], engine);

    const event = makeEvent("evt-5", "action.succeeded", {});
    event.tenantId = "tenant-abc";
    event.actor = { type: "user", id: "user-1" };

    await bus.emit("action.succeeded", event);

    const opts = engine.started[0]?.options as {
      tenantId?: string;
      actor?: unknown;
    };
    expect(opts?.tenantId).toBe("tenant-abc");
    // TriggerBinding normalizes EventRecord.actor (no groups) to full Actor shape
    expect(opts?.actor).toEqual({ type: "user", id: "user-1", groups: [] });
  });

  it("unbindAll removes all subscriptions", async () => {
    const bus = createMockEventBus();
    const engine = createMockFlowEngine();
    const binding = createTriggerBinding(bus);

    binding.bindAll([eventFlow, unfilteredEventFlow], engine);
    expect(bus.handlers.get("action.succeeded")?.length).toBe(2);

    binding.unbindAll();

    // Handlers should be removed
    expect(bus.handlers.get("action.succeeded")?.length).toBe(0);
  });

  it("binds multiple flows to the same event type", async () => {
    const bus = createMockEventBus();
    const engine = createMockFlowEngine();
    const binding = createTriggerBinding(bus);

    binding.bindAll([eventFlow, unfilteredEventFlow], engine);

    await bus.emit(
      "action.succeeded",
      makeEvent("evt-4", "action.succeeded", {
        actionName: "purchase_request.submit",
      }),
    );

    // Both flows should start (eventFlow matches filter, unfilteredEventFlow has no filter)
    expect(engine.started).toHaveLength(2);
    expect(engine.started.map((s) => s.flowName).sort()).toEqual(["audit-log", "on-submit"]);
  });
});

// ── Schedule trigger tests ──────────────────────────────

describe("TriggerBinding — schedule triggers", () => {
  const scheduleFlow: FlowDefinition = {
    name: "daily-cleanup",
    trigger: { type: "schedule", cron: "* * * * *" },
    steps: [{ id: "s1", name: "Cleanup", type: "action", actionName: "cleanup.run" }],
  };

  it("binds a valid cron schedule without error", () => {
    const bus = createMockEventBus();
    const engine = createMockFlowEngine();
    const binding = createTriggerBinding(bus);

    // Should not throw
    binding.bindAll([scheduleFlow], engine);
    binding.unbindAll();
  });

  it("logs warning for invalid cron expression without crashing", () => {
    const bus = createMockEventBus();
    const engine = createMockFlowEngine();
    const warnings: string[] = [];
    const logger: Logger = {
      debug() {},
      info() {},
      warn(msg: string) {
        warnings.push(msg);
      },
      error() {},
    };
    const binding = createTriggerBinding(bus, logger);

    const badFlow: FlowDefinition = {
      name: "bad-cron",
      trigger: { type: "schedule", cron: "not-valid-cron" },
      steps: [{ id: "s1", name: "Step", type: "action", actionName: "test" }],
    };

    // Should not throw
    binding.bindAll([badFlow], engine);
    expect(warnings.some((w) => w.includes("Invalid cron"))).toBe(true);
    binding.unbindAll();
  });

  it("unbindAll stops cron jobs", () => {
    const bus = createMockEventBus();
    const engine = createMockFlowEngine();
    const binding = createTriggerBinding(bus);

    binding.bindAll([scheduleFlow], engine);
    // Should not throw, cleans up cron jobs
    binding.unbindAll();
    // Second unbindAll should be safe (idempotent)
    binding.unbindAll();
  });
});
