import { describe, expect, it, mock } from "bun:test";
import {
  detectFlowCycle,
  emitFlowCompletionEvent,
  FLOW_COMPLETED_EVENT,
  FLOW_FAILED_EVENT,
  getFlowDependencies,
  resolveInputMapping,
  validateFlowChains,
} from "../src/flow/flow-chaining";
import type { FlowCompletedPayload } from "../src/flow/flow-chaining";
import { createFlowRegistry } from "../src/flow/flow-registry";
import { createSyncFlowEngine } from "../src/flow/sync-engine";
import type { FlowStepContext } from "../src/flow/types";
import type { EventRecord } from "../src/types/event";
import type { FlowDefinition } from "../src/types/flow";

// ── Mock step context ───────────────────────────────────

function createMockStepContext(
  actions: Record<string, (input: Record<string, unknown>) => Record<string, unknown>> = {},
): FlowStepContext {
  return {
    flowContext: {},
    async executeAction(actionName, input) {
      const handler = actions[actionName];
      if (!handler) {
        return { success: true, actionName };
      }
      return handler(input);
    },
    async callAI() {
      return { response: "mock AI response", tokensUsed: 10 };
    },
    evaluateCondition(expression) {
      return expression === "true";
    },
  };
}

// ── Test fixtures ───────────────────────────────────────

const flowA: FlowDefinition = {
  name: "flow-a",
  trigger: { type: "manual" },
  steps: [
    { id: "step1", name: "Step 1", type: "action", actionName: "do.a" },
  ],
  onComplete: {
    flow: "flow-b",
    inputMapping: { orderId: "$result.__steps.step1.output.orderId" },
  },
};

const flowB: FlowDefinition = {
  name: "flow-b",
  trigger: { type: "manual" },
  steps: [
    { id: "step1", name: "Step 1", type: "action", actionName: "do.b" },
  ],
};

const flowC: FlowDefinition = {
  name: "flow-c",
  trigger: { type: "manual" },
  steps: [
    { id: "step1", name: "Step 1", type: "action", actionName: "do.c" },
  ],
};

// ── Tests ───────────────────────────────────────────────

describe("Flow Chaining", () => {
  describe("emitFlowCompletionEvent", () => {
    it("emits flow.completed event on successful completion", () => {
      const emittedEvents: EventRecord[] = [];
      const eventBus = {
        subscribe: () => () => {},
        emit: async (event: EventRecord) => {
          emittedEvents.push(event);
        },
      };

      emitFlowCompletionEvent(eventBus, {
        id: "inst-1",
        flowName: "my-flow",
        status: "completed",
        currentStepId: "step1",
        context: { __steps: { step1: { output: { result: "ok" } } } },
        startedAt: new Date(),
        completedAt: new Date(),
      });

      // Event is emitted asynchronously, give it a tick
      expect(emittedEvents.length).toBe(1);
      expect(emittedEvents[0]!.type).toBe(FLOW_COMPLETED_EVENT);
      expect((emittedEvents[0]!.payload as FlowCompletedPayload).flowName).toBe("my-flow");
      expect((emittedEvents[0]!.payload as FlowCompletedPayload).status).toBe("completed");
    });

    it("emits flow.failed event on failure", () => {
      const emittedEvents: EventRecord[] = [];
      const eventBus = {
        subscribe: () => () => {},
        emit: async (event: EventRecord) => {
          emittedEvents.push(event);
        },
      };

      emitFlowCompletionEvent(eventBus, {
        id: "inst-2",
        flowName: "my-flow",
        status: "failed",
        currentStepId: "step1",
        context: {},
        startedAt: new Date(),
        error: { stepId: "step1", message: "DB error" },
      });

      expect(emittedEvents.length).toBe(1);
      expect(emittedEvents[0]!.type).toBe(FLOW_FAILED_EVENT);
      expect((emittedEvents[0]!.payload as FlowCompletedPayload).error?.message).toBe("DB error");
    });

    it("does not throw when eventBus has no emit method", () => {
      const eventBus = { subscribe: () => () => {} };
      // Should not throw
      emitFlowCompletionEvent(eventBus, {
        id: "inst-3",
        flowName: "my-flow",
        status: "completed",
        currentStepId: "step1",
        context: {},
        startedAt: new Date(),
      });
    });
  });

  describe("resolveInputMapping", () => {
    const payload: FlowCompletedPayload = {
      flowName: "upstream-flow",
      instanceId: "inst-123",
      status: "completed",
      result: {
        __steps: {
          calculate: { output: { total: 5000, currency: "USD" } },
        },
        __input: { requestId: "req-1" },
      },
    };

    it("maps $flowName", () => {
      const input = resolveInputMapping({ source: "$flowName" }, payload);
      expect(input.source).toBe("upstream-flow");
    });

    it("maps $instanceId", () => {
      const input = resolveInputMapping({ id: "$instanceId" }, payload);
      expect(input.id).toBe("inst-123");
    });

    it("maps $status", () => {
      const input = resolveInputMapping({ s: "$status" }, payload);
      expect(input.s).toBe("completed");
    });

    it("maps nested $result paths", () => {
      const input = resolveInputMapping(
        { total: "$result.__steps.calculate.output.total" },
        payload,
      );
      expect(input.total).toBe(5000);
    });

    it("maps $error paths", () => {
      const errorPayload: FlowCompletedPayload = {
        flowName: "err-flow",
        instanceId: "inst-err",
        status: "failed",
        result: {},
        error: { stepId: "s1", message: "boom" },
      };
      const input = resolveInputMapping({ msg: "$error.message" }, errorPayload);
      expect(input.msg).toBe("boom");
    });

    it("passes through literal values", () => {
      const input = resolveInputMapping({ key: "literal-value" }, payload);
      expect(input.key).toBe("literal-value");
    });

    it("returns undefined for non-existent paths", () => {
      const input = resolveInputMapping({ x: "$result.nonexistent.deep" }, payload);
      expect(input.x).toBeUndefined();
    });
  });

  describe("detectFlowCycle", () => {
    it("returns null when no cycle exists", () => {
      const registry = createFlowRegistry();
      registry.register(flowA);
      registry.register(flowB);

      const cycle = detectFlowCycle(registry, "flow-a");
      expect(cycle).toBeNull();
    });

    it("detects direct A -> B -> A cycle", () => {
      const registry = createFlowRegistry();
      const cyclicB: FlowDefinition = {
        ...flowB,
        onComplete: { flow: "flow-a", inputMapping: {} },
      };
      registry.register(flowA);
      registry.register(cyclicB);

      const cycle = detectFlowCycle(registry, "flow-a");
      expect(cycle).not.toBeNull();
      expect(cycle).toContain("flow-a");
      expect(cycle).toContain("flow-b");
    });

    it("detects indirect A -> B -> C -> A cycle", () => {
      const registry = createFlowRegistry();
      const chainB: FlowDefinition = {
        ...flowB,
        onComplete: { flow: "flow-c", inputMapping: {} },
      };
      const chainC: FlowDefinition = {
        ...flowC,
        onComplete: { flow: "flow-a", inputMapping: {} },
      };
      registry.register(flowA);
      registry.register(chainB);
      registry.register(chainC);

      const cycle = detectFlowCycle(registry, "flow-a");
      expect(cycle).not.toBeNull();
      expect(cycle!.length).toBeGreaterThanOrEqual(3);
    });

    it("handles self-referencing flow", () => {
      const registry = createFlowRegistry();
      const selfRef: FlowDefinition = {
        name: "self-flow",
        trigger: { type: "manual" },
        steps: [{ id: "s1", name: "Step", type: "action", actionName: "do.x" }],
        onComplete: { flow: "self-flow", inputMapping: {} },
      };
      registry.register(selfRef);

      const cycle = detectFlowCycle(registry, "self-flow");
      expect(cycle).not.toBeNull();
      expect(cycle).toEqual(["self-flow", "self-flow"]);
    });

    it("considers additional automation chains", () => {
      const registry = createFlowRegistry();
      // flow-a has no onComplete, but an automation chain connects A -> B
      const plainA: FlowDefinition = {
        name: "flow-a",
        trigger: { type: "manual" },
        steps: [{ id: "s1", name: "Step", type: "action", actionName: "do.a" }],
      };
      const chainedB: FlowDefinition = {
        ...flowB,
        onComplete: { flow: "flow-a", inputMapping: {} },
      };
      registry.register(plainA);
      registry.register(chainedB);

      const automationChains = new Map([["flow-a", ["flow-b"]]]);
      const cycle = detectFlowCycle(registry, "flow-a", automationChains);
      expect(cycle).not.toBeNull();
    });
  });

  describe("validateFlowChains", () => {
    it("does not throw for valid chains", () => {
      const registry = createFlowRegistry();
      registry.register(flowB);

      expect(() => validateFlowChains(flowA, registry)).not.toThrow();
    });

    it("throws on cycle introduction", () => {
      const registry = createFlowRegistry();
      registry.register(flowA);

      const cyclicB: FlowDefinition = {
        ...flowB,
        onComplete: { flow: "flow-a", inputMapping: {} },
      };

      expect(() => validateFlowChains(cyclicB, registry)).toThrow(/cycle detected/i);
    });
  });

  describe("getFlowDependencies", () => {
    it("returns downstream from onComplete", () => {
      const registry = createFlowRegistry();
      registry.register(flowA);
      registry.register(flowB);

      const deps = getFlowDependencies(registry, "flow-a");
      expect(deps.downstream).toContain("flow-b");
      expect(deps.upstream).toEqual([]);
    });

    it("returns upstream for target flow", () => {
      const registry = createFlowRegistry();
      registry.register(flowA);
      registry.register(flowB);

      const deps = getFlowDependencies(registry, "flow-b");
      expect(deps.upstream).toContain("flow-a");
      expect(deps.downstream).toEqual([]);
    });

    it("includes automation chains", () => {
      const registry = createFlowRegistry();
      registry.register(flowB);
      registry.register(flowC);

      const automationChains = new Map([["flow-b", ["flow-c"]]]);
      const deps = getFlowDependencies(registry, "flow-b", automationChains);
      expect(deps.downstream).toContain("flow-c");
    });

    it("returns empty for isolated flow", () => {
      const registry = createFlowRegistry();
      registry.register(flowB);

      const deps = getFlowDependencies(registry, "flow-b");
      expect(deps.upstream).toEqual([]);
      expect(deps.downstream).toEqual([]);
    });
  });

  describe("SyncFlowEngine with chaining", () => {
    it("emits flow.completed event via eventBus after flow finishes", async () => {
      const emittedEvents: EventRecord[] = [];
      const eventBus = {
        subscribe: () => () => {},
        emit: async (event: EventRecord) => {
          emittedEvents.push(event);
        },
      };

      const ctx = createMockStepContext();
      const engine = createSyncFlowEngine(ctx, { eventBus });
      engine.registerFlow(flowB);

      await engine.startFlow("flow-b", { data: "test" });

      expect(emittedEvents.length).toBe(1);
      expect(emittedEvents[0]!.type).toBe("flow.completed");
      const payload = emittedEvents[0]!.payload as unknown as FlowCompletedPayload;
      expect(payload.flowName).toBe("flow-b");
      expect(payload.status).toBe("completed");
    });

    it("emits flow.failed event when flow fails", async () => {
      const emittedEvents: EventRecord[] = [];
      const eventBus = {
        subscribe: () => () => {},
        emit: async (event: EventRecord) => {
          emittedEvents.push(event);
        },
      };

      const ctx = createMockStepContext({
        "do.b": () => {
          throw new Error("boom");
        },
      });
      const engine = createSyncFlowEngine(ctx, { eventBus });
      engine.registerFlow(flowB);

      const instance = await engine.startFlow("flow-b", {});
      expect(instance.status).toBe("failed");
      expect(emittedEvents.length).toBe(1);
      expect(emittedEvents[0]!.type).toBe("flow.failed");
    });

    it("triggers downstream flow via onComplete chain", async () => {
      const executedActions: string[] = [];
      const ctx = createMockStepContext({
        "do.a": () => {
          executedActions.push("do.a");
          return { orderId: "ord-1" };
        },
        "do.b": (input) => {
          executedActions.push("do.b");
          return { received: input };
        },
      });

      const registry = createFlowRegistry();
      registry.register(flowA);
      registry.register(flowB);

      const engine = createSyncFlowEngine(ctx, { flowRegistry: registry });
      engine.registerFlow(flowA);
      engine.registerFlow(flowB);

      await engine.startFlow("flow-a", { userId: "u-1" });

      // Both flows should have executed
      expect(executedActions).toContain("do.a");
      expect(executedActions).toContain("do.b");
    });

    it("chains with multiple downstream flows", async () => {
      const executedActions: string[] = [];
      const ctx = createMockStepContext({
        "do.a": () => {
          executedActions.push("do.a");
          return {};
        },
        "do.b": () => {
          executedActions.push("do.b");
          return {};
        },
        "do.c": () => {
          executedActions.push("do.c");
          return {};
        },
      });

      const multiChainA: FlowDefinition = {
        name: "flow-a",
        trigger: { type: "manual" },
        steps: [{ id: "s1", name: "Step", type: "action", actionName: "do.a" }],
        onComplete: [
          { flow: "flow-b" },
          { flow: "flow-c" },
        ],
      };

      const registry = createFlowRegistry();
      registry.register(multiChainA);
      registry.register(flowB);
      registry.register(flowC);

      const engine = createSyncFlowEngine(ctx, { flowRegistry: registry });
      engine.registerFlow(multiChainA);
      engine.registerFlow(flowB);
      engine.registerFlow(flowC);

      await engine.startFlow("flow-a", {});

      expect(executedActions).toContain("do.a");
      expect(executedActions).toContain("do.b");
      expect(executedActions).toContain("do.c");
    });

    it("does not chain when flow fails and onStatus is completed", async () => {
      const executedActions: string[] = [];
      const ctx = createMockStepContext({
        "do.a": () => {
          throw new Error("fail");
        },
        "do.b": () => {
          executedActions.push("do.b");
          return {};
        },
      });

      const registry = createFlowRegistry();
      registry.register(flowA);
      registry.register(flowB);

      const engine = createSyncFlowEngine(ctx, { flowRegistry: registry });
      engine.registerFlow(flowA);
      engine.registerFlow(flowB);

      const instance = await engine.startFlow("flow-a", {});
      expect(instance.status).toBe("failed");
      // flow-b should NOT have been triggered (onStatus defaults to "completed")
      expect(executedActions).not.toContain("do.b");
    });
  });
});
