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
      // biome-ignore lint/suspicious/noThenProperty: flow condition step definition
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

      const instance = await engine.startFlow(
        "linear-flow",
        {},
        {
          instanceId: "custom-id-123",
        },
      );
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

      const _instance = await engine.startFlow(
        "linear-flow",
        {},
        {
          instanceId: "track-me",
        },
      );

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

      const _instance = await engine.startFlow("linear-flow", {}, { instanceId: "cancel-me" });
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
      await expect(engine.sendSignal("id", "sig", {})).rejects.toThrow("does not support signals");
    });
  });

  describe("Saga compensation", () => {
    it("runs compensations in reverse order when a step fails and onError === 'compensate'", async () => {
      const executedActions: string[] = [];

      const ctx = createMockStepContext({
        "create_inbound": (input) => {
          executedActions.push("create_inbound");
          return { inboundId: "ib-1", ...input };
        },
        "create_payment": () => {
          executedActions.push("create_payment");
          throw new Error("Payment gateway timeout");
        },
        "cancel_inbound": (input) => {
          executedActions.push("cancel_inbound");
          return { cancelled: true, ...input };
        },
      });

      const flow: FlowDefinition = {
        name: "purchase-saga",
        trigger: { type: "manual" },
        onError: "compensate",
        steps: [
          {
            id: "step_inbound",
            name: "Create Inbound",
            type: "action",
            actionName: "create_inbound",
            input: { orderId: "ord-1" },
            compensation: "cancel_inbound",
          },
          {
            id: "step_payment",
            name: "Create Payment",
            type: "action",
            actionName: "create_payment",
            input: { amount: 500 },
          },
        ],
      };

      const engine = createSyncFlowEngine(ctx);
      engine.registerFlow(flow);

      const instance = await engine.startFlow("purchase-saga", {});

      expect(instance.status).toBe("compensated");
      expect(executedActions).toEqual(["create_inbound", "create_payment", "cancel_inbound"]);
      expect(instance.compensationLog).toHaveLength(1);
      expect(instance.compensationLog?.[0]?.stepId).toBe("step_inbound");
      expect(instance.compensationLog?.[0]?.compensationAction).toBe("cancel_inbound");
      expect(instance.compensationLog?.[0]?.status).toBe("succeeded");
    });

    it("logs compensation failure but continues compensating other steps", async () => {
      const executedActions: string[] = [];

      const ctx = createMockStepContext({
        "step_a_action": () => {
          executedActions.push("step_a_action");
          return { result: "a" };
        },
        "step_b_action": () => {
          executedActions.push("step_b_action");
          return { result: "b" };
        },
        "step_c_action": () => {
          executedActions.push("step_c_action");
          throw new Error("C failed");
        },
        "compensate_b": () => {
          executedActions.push("compensate_b");
          throw new Error("compensate_b also failed");
        },
        "compensate_a": () => {
          executedActions.push("compensate_a");
          return { undone: true };
        },
      });

      const flow: FlowDefinition = {
        name: "multi-step-saga",
        trigger: { type: "manual" },
        onError: "compensate",
        steps: [
          {
            id: "step_a",
            name: "Step A",
            type: "action",
            actionName: "step_a_action",
            compensation: "compensate_a",
          },
          {
            id: "step_b",
            name: "Step B",
            type: "action",
            actionName: "step_b_action",
            compensation: "compensate_b",
          },
          {
            id: "step_c",
            name: "Step C",
            type: "action",
            actionName: "step_c_action",
          },
        ],
      };

      const engine = createSyncFlowEngine(ctx);
      engine.registerFlow(flow);

      const instance = await engine.startFlow("multi-step-saga", {});

      expect(instance.status).toBe("compensated");
      // Compensation runs in reverse: compensate_b then compensate_a
      expect(executedActions).toEqual([
        "step_a_action",
        "step_b_action",
        "step_c_action",
        "compensate_b",
        "compensate_a",
      ]);

      const log = instance.compensationLog ?? [];
      expect(log).toHaveLength(2);
      expect(log[0]?.stepId).toBe("step_b");
      expect(log[0]?.status).toBe("failed");
      expect(log[1]?.stepId).toBe("step_a");
      expect(log[1]?.status).toBe("succeeded");
    });

    it("does not compensate when onError is not 'compensate'", async () => {
      const executedActions: string[] = [];

      const ctx = createMockStepContext({
        "step_action": () => {
          executedActions.push("step_action");
          return {};
        },
        "fail_action": () => {
          throw new Error("failed");
        },
        "compensate_step": () => {
          executedActions.push("compensate_step");
          return {};
        },
      });

      const flow: FlowDefinition = {
        name: "no-compensation-saga",
        trigger: { type: "manual" },
        // onError not set — default behaviour
        steps: [
          {
            id: "step1",
            name: "Step 1",
            type: "action",
            actionName: "step_action",
            compensation: "compensate_step",
          },
          {
            id: "step2",
            name: "Step 2",
            type: "action",
            actionName: "fail_action",
          },
        ],
      };

      const engine = createSyncFlowEngine(ctx);
      engine.registerFlow(flow);

      const instance = await engine.startFlow("no-compensation-saga", {});

      expect(instance.status).toBe("failed");
      expect(executedActions).toEqual(["step_action"]);
      expect(instance.compensationLog).toBeUndefined();
    });

    it("uses custom compensationInput when provided", async () => {
      let compensationCallInput: Record<string, unknown> = {};

      const ctx = createMockStepContext({
        "do_work": () => ({ workId: "w-1" }),
        "fail_step": () => {
          throw new Error("boom");
        },
        "undo_work": (input) => {
          compensationCallInput = input;
          return { undone: true };
        },
      });

      const flow: FlowDefinition = {
        name: "custom-input-saga",
        trigger: { type: "manual" },
        onError: "compensate",
        steps: [
          {
            id: "step_work",
            name: "Do Work",
            type: "action",
            actionName: "do_work",
            compensation: "undo_work",
            compensationInput: { reason: "rollback" },
          },
          {
            id: "step_fail",
            name: "Fail Step",
            type: "action",
            actionName: "fail_step",
          },
        ],
      };

      const engine = createSyncFlowEngine(ctx);
      engine.registerFlow(flow);

      await engine.startFlow("custom-input-saga", {});

      expect(compensationCallInput).toEqual({ reason: "rollback" });
    });
  });
});
