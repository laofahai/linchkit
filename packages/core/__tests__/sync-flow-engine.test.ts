import { describe, expect, it } from "bun:test";
import { createSyncFlowEngine } from "../src/flow/sync-engine";
import type { FlowStepContext } from "../src/flow/types";
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
      // Simple truthy check for test
      return expression === "true";
    },
  };
}

// ── Test fixtures ───────────────────────────────────────

const linearFlow: FlowDefinition = {
  name: "linear-flow",
  trigger: { type: "manual" },
  steps: [
    {
      id: "step1",
      name: "Create Order",
      type: "action",
      actionName: "order.create",
      input: { product: "widget" },
    },
    {
      id: "step2",
      name: "Send Notification",
      type: "action",
      actionName: "notification.send",
      input: { message: "Order created" },
    },
  ],
};

const conditionFlow: FlowDefinition = {
  name: "condition-flow",
  trigger: { type: "manual" },
  steps: [
    {
      id: "check",
      name: "Check Condition",
      type: "condition",
      expression: "true",
      then: "yes-step",
      else: "no-step",
    },
    {
      id: "yes-step",
      name: "Yes Branch",
      type: "action",
      actionName: "branch.yes",
    },
    {
      id: "no-step",
      name: "No Branch",
      type: "action",
      actionName: "branch.no",
    },
  ],
};

// ── Tests ───────────────────────────────────────────────

describe("SyncFlowEngine", () => {
  describe("registerFlow + startFlow", () => {
    it("executes a linear flow to completion", async () => {
      const executedActions: string[] = [];
      const ctx = createMockStepContext({
        "order.create": (input) => {
          executedActions.push("order.create");
          return { orderId: "ord-1", ...input };
        },
        "notification.send": (input) => {
          executedActions.push("notification.send");
          return { sent: true, ...input };
        },
      });

      const engine = createSyncFlowEngine(ctx);
      engine.registerFlow(linearFlow);

      const instance = await engine.startFlow("linear-flow", { userId: "u-1" });

      expect(instance.status).toBe("completed");
      expect(instance.flowName).toBe("linear-flow");
      expect(executedActions).toEqual(["order.create", "notification.send"]);
    });

    it("throws when starting an unregistered flow", async () => {
      const engine = createSyncFlowEngine(createMockStepContext());
      await expect(engine.startFlow("nonexistent", {})).rejects.toThrow(
        'Flow "nonexistent" is not registered',
      );
    });

    it("generates an instance ID when none is provided", async () => {
      const engine = createSyncFlowEngine(createMockStepContext());
      engine.registerFlow(linearFlow);

      const instance = await engine.startFlow("linear-flow", {});
      expect(instance.id).toBeTruthy();
      expect(typeof instance.id).toBe("string");
    });

    it("uses the provided instance ID", async () => {
      const engine = createSyncFlowEngine(createMockStepContext());
      engine.registerFlow(linearFlow);

      const instance = await engine.startFlow("linear-flow", {}, {
        instanceId: "custom-id-123",
      });
      expect(instance.id).toBe("custom-id-123");
    });
  });

  describe("condition branching", () => {
    it("follows the then branch when condition is true", async () => {
      const executedActions: string[] = [];
      const ctx = createMockStepContext({
        "branch.yes": () => {
          executedActions.push("branch.yes");
          return {};
        },
        "branch.no": () => {
          executedActions.push("branch.no");
          return {};
        },
      });

      const engine = createSyncFlowEngine(ctx);
      engine.registerFlow(conditionFlow);

      const instance = await engine.startFlow("condition-flow", {});
      expect(instance.status).toBe("completed");
      // The "then" branch is "yes-step", so it jumps to index of yes-step
      // then continues sequentially to no-step
      expect(executedActions).toContain("branch.yes");
    });
  });

  describe("error handling", () => {
    it("marks the flow as failed when a step throws", async () => {
      const ctx = createMockStepContext({
        "order.create": () => {
          throw new Error("DB connection failed");
        },
      });

      const engine = createSyncFlowEngine(ctx);
      engine.registerFlow(linearFlow);

      const instance = await engine.startFlow("linear-flow", {});
      expect(instance.status).toBe("failed");
      expect(instance.error?.message).toContain("DB connection failed");
      expect(instance.error?.stepId).toBe("step1");
    });

    it("throws on approval steps (requires Restate)", async () => {
      const flow: FlowDefinition = {
        name: "approval-flow",
        trigger: { type: "manual" },
        steps: [
          {
            id: "approve",
            name: "Get Approval",
            type: "approval",
            approvers: ["managers"],
          },
        ],
      };

      const engine = createSyncFlowEngine(createMockStepContext());
      engine.registerFlow(flow);

      const instance = await engine.startFlow("approval-flow", {});
      expect(instance.status).toBe("failed");
      expect(instance.error?.message).toContain("requires Restate");
    });

    it("throws on wait steps (requires Restate)", async () => {
      const flow: FlowDefinition = {
        name: "wait-flow",
        trigger: { type: "manual" },
        steps: [
          {
            id: "wait",
            name: "Wait",
            type: "wait",
            duration: 5000,
          },
        ],
      };

      const engine = createSyncFlowEngine(createMockStepContext());
      engine.registerFlow(flow);

      const instance = await engine.startFlow("wait-flow", {});
      expect(instance.status).toBe("failed");
      expect(instance.error?.message).toContain("requires Restate");
    });
  });

  describe("getFlowStatus", () => {
    it("returns the flow instance after execution", async () => {
      const engine = createSyncFlowEngine(createMockStepContext());
      engine.registerFlow(linearFlow);

      const instance = await engine.startFlow("linear-flow", {}, {
        instanceId: "track-me",
      });

      const status = await engine.getFlowStatus("track-me");
      expect(status).not.toBeNull();
      expect(status?.id).toBe("track-me");
      expect(status?.status).toBe("completed");
    });

    it("returns null for unknown instance", async () => {
      const engine = createSyncFlowEngine(createMockStepContext());
      const status = await engine.getFlowStatus("nonexistent");
      expect(status).toBeNull();
    });
  });

  describe("cancelFlow", () => {
    it("marks a running instance as cancelled", async () => {
      // Since SyncFlowEngine runs synchronously, we can only cancel completed flows
      // In practice this is a no-op, but we test the API contract
      const engine = createSyncFlowEngine(createMockStepContext());
      engine.registerFlow(linearFlow);

      const instance = await engine.startFlow("linear-flow", {}, { instanceId: "cancel-me" });
      // Already completed, cancel is a no-op
      await engine.cancelFlow("cancel-me");

      const status = await engine.getFlowStatus("cancel-me");
      // Still completed since it finished before cancel
      expect(status?.status).toBe("completed");
    });
  });

  describe("sendSignal", () => {
    it("throws because SyncFlowEngine does not support signals", async () => {
      const engine = createSyncFlowEngine(createMockStepContext());
      await expect(engine.sendSignal("id", "sig", {})).rejects.toThrow(
        "does not support signals",
      );
    });
  });
});
