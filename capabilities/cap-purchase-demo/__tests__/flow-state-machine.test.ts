/**
 * E2E test: Purchase Flow + State Machine collaboration
 *
 * Demonstrates how the two systems work together:
 * - State Machine: guards WHAT transitions are legal (draft→pending→approved/rejected)
 * - Flow: orchestrates WHEN and HOW transitions happen (auto-approve, flag for review)
 *
 * Trigger chain in production:
 *   User calls submit_purchase_request action
 *     → CommandLayer executes it (draft → pending)
 *     → EventBus emits "action.succeeded" event
 *     → TriggerBinding matches purchaseApprovalFlow trigger
 *     → FlowEngine.startFlow() runs automatically
 *     → Flow checks amount, auto-approves or flags for manager
 *
 * In these tests, we simulate the event trigger by calling startFlow directly.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { Actor } from "@linchkit/core";
import {
  canTransition,
  createStateMachine,
  createSyncFlowEngine,
  getAvailableActions,
  InMemoryStore,
  transition,
} from "@linchkit/core/server";
import type { FlowStepContext } from "@linchkit/core/server";
import { purchaseApprovalFlow } from "../src/flows/purchase-approval";
import { purchaseRequestState } from "../src/states/purchase-request";

// ── Actors ──────────────────────────────────────────────

const managerActor: Actor = {
  type: "human",
  id: "mgr-001",
  name: "Bob Manager",
  groups: ["manager"],
};

// ── Test helpers ────────────────────────────────────────

/**
 * Create a FlowStepContext backed by InMemoryStore.
 * Simulates real action execution so we can verify state changes.
 */
function createTestFlowContext(store: InstanceType<typeof InMemoryStore>): FlowStepContext {
  return {
    flowContext: {},
    async executeAction(actionName: string, input: Record<string, unknown>) {
      const id = input.id as string;

      if (actionName === "approve_purchase_request") {
        const record = await store.get("purchase_request", id);
        if (!record) throw new Error(`Record not found: ${id}`);
        return store.update("purchase_request", id, {
          status: "approved",
          approved_at: new Date().toISOString(),
          approved_by: "system:auto-approval",
        });
      }

      if (actionName === "update_purchase_request") {
        const recordId = input.id as string;
        const { id: _id, ...updates } = input;
        return store.update("purchase_request", recordId, updates);
      }

      throw new Error(`Unknown action: ${actionName}`);
    },
    async callAI() {
      return { response: "mock", tokensUsed: 0 };
    },
    evaluateCondition(expression: string) {
      return expression === "true";
    },
  };
}

// ══════════════════════════════════════════════════════════
// Part 1: State Machine — transition guards
// ══════════════════════════════════════════════════════════

describe("Purchase State Machine — transition guards", () => {
  const machine = createStateMachine(purchaseRequestState);

  test("defines 4 states with draft as initial", () => {
    expect(purchaseRequestState.states).toEqual(["draft", "pending", "approved", "rejected"]);
    expect(purchaseRequestState.initial).toBe("draft");
  });

  test("valid transitions: the happy path", () => {
    // draft → pending → approved
    expect(transition(machine, "draft", "submit_purchase_request")).toMatchObject({ allowed: true, to: "pending" });
    expect(transition(machine, "pending", "approve_purchase_request")).toMatchObject({ allowed: true, to: "approved" });
  });

  test("valid transitions: rejection path", () => {
    expect(transition(machine, "pending", "reject_purchase_request")).toMatchObject({ allowed: true, to: "rejected" });
  });

  test("valid transitions: resubmit after rejection", () => {
    expect(transition(machine, "rejected", "submit_purchase_request")).toMatchObject({ allowed: true, to: "pending" });
  });

  test("BLOCKED: cannot skip states", () => {
    // Cannot approve a draft directly (must submit first)
    expect(transition(machine, "draft", "approve_purchase_request").allowed).toBe(false);
    // Cannot reject a draft directly
    expect(transition(machine, "draft", "reject_purchase_request").allowed).toBe(false);
  });

  test("BLOCKED: approved is terminal", () => {
    expect(getAvailableActions(machine, "approved")).toHaveLength(0);
    expect(transition(machine, "approved", "submit_purchase_request").allowed).toBe(false);
    expect(transition(machine, "approved", "reject_purchase_request").allowed).toBe(false);
  });

  test("available actions depend on current state", () => {
    expect(getAvailableActions(machine, "draft")).toEqual(["submit_purchase_request"]);
    expect(getAvailableActions(machine, "pending")).toContain("approve_purchase_request");
    expect(getAvailableActions(machine, "pending")).toContain("reject_purchase_request");
    expect(getAvailableActions(machine, "rejected")).toEqual(["submit_purchase_request"]);
  });

  test("canTransition convenience check", () => {
    expect(canTransition(machine, "draft", "submit_purchase_request")).toBe(true);
    expect(canTransition(machine, "draft", "approve_purchase_request")).toBe(false);
    expect(canTransition(machine, "pending", "reject_purchase_request")).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════
// Part 2: Flow — approval orchestration
// ══════════════════════════════════════════════════════════

describe("Purchase Approval Flow — auto-approval routing", () => {
  let store: InstanceType<typeof InMemoryStore>;

  beforeEach(() => {
    store = new InMemoryStore();
  });

  test("small purchase (<=5000): auto-approved by flow", async () => {
    const record = await store.create("purchase_request", {
      title: "Office Supplies",
      amount: 3000,
      status: "pending",
    });

    const engine = createSyncFlowEngine(createTestFlowContext(store));
    engine.registerFlow(purchaseApprovalFlow);

    // Simulate: EventBus fires "action.succeeded" → TriggerBinding → startFlow
    const instance = await engine.startFlow("purchase_approval", {
      id: record.id,
      amount: 3000,
    });

    expect(instance.status).toBe("completed");
    const updated = await store.get("purchase_request", record.id);
    expect(updated.status).toBe("approved");
    expect(updated.approved_by).toBe("system:auto-approval");
  });

  test("large purchase (>5000): flagged for review, stays pending", async () => {
    const record = await store.create("purchase_request", {
      title: "Server Hardware",
      amount: 25000,
      status: "pending",
    });

    const engine = createSyncFlowEngine(createTestFlowContext(store));
    engine.registerFlow(purchaseApprovalFlow);

    const instance = await engine.startFlow("purchase_approval", {
      id: record.id,
      amount: 25000,
    });

    expect(instance.status).toBe("completed");
    const updated = await store.get("purchase_request", record.id);
    expect(updated.status).toBe("pending"); // NOT auto-approved
    expect(String(updated.audit_notes)).toContain("manager approval");
  });

  test("boundary: exactly 5000 → auto-approved", async () => {
    const record = await store.create("purchase_request", {
      title: "Boundary",
      amount: 5000,
      status: "pending",
    });

    const engine = createSyncFlowEngine(createTestFlowContext(store));
    engine.registerFlow(purchaseApprovalFlow);
    await engine.startFlow("purchase_approval", { id: record.id, amount: 5000 });

    expect((await store.get("purchase_request", record.id)).status).toBe("approved");
  });

  test("boundary: 5001 → stays pending", async () => {
    const record = await store.create("purchase_request", {
      title: "Boundary",
      amount: 5001,
      status: "pending",
    });

    const engine = createSyncFlowEngine(createTestFlowContext(store));
    engine.registerFlow(purchaseApprovalFlow);
    await engine.startFlow("purchase_approval", { id: record.id, amount: 5001 });

    const updated = await store.get("purchase_request", record.id);
    expect(updated.status).toBe("pending");
    expect(String(updated.audit_notes)).toContain("manager approval");
  });
});

// ══════════════════════════════════════════════════════════
// Part 3: Full lifecycle — State Machine + Flow together
// ══════════════════════════════════════════════════════════

describe("Full Lifecycle — State Machine + Flow collaboration", () => {
  let store: InstanceType<typeof InMemoryStore>;
  const machine = createStateMachine(purchaseRequestState);

  beforeEach(() => {
    store = new InMemoryStore();
  });

  test("small purchase: create → submit → flow auto-approves", async () => {
    // 1. Create draft
    const record = await store.create("purchase_request", {
      title: "Pens",
      amount: 200,
      status: "draft",
    });
    expect(record.status).toBe("draft");

    // 2. State machine validates: draft→pending is OK
    expect(transition(machine, "draft", "submit_purchase_request").allowed).toBe(true);
    await store.update("purchase_request", record.id, { status: "pending" });

    // 3. EventBus would trigger the flow — we simulate it directly
    const engine = createSyncFlowEngine(createTestFlowContext(store));
    engine.registerFlow(purchaseApprovalFlow);
    const instance = await engine.startFlow("purchase_approval", {
      id: record.id,
      amount: 200,
    });

    // 4. Verify: flow completed, record is approved
    expect(instance.status).toBe("completed");
    expect((await store.get("purchase_request", record.id)).status).toBe("approved");
  });

  test("large purchase: create → submit → flow flags → manager manually approves", async () => {
    // 1. Create & submit
    const record = await store.create("purchase_request", {
      title: "Office Renovation",
      amount: 30000,
      status: "draft",
    });
    expect(transition(machine, "draft", "submit_purchase_request").allowed).toBe(true);
    await store.update("purchase_request", record.id, { status: "pending" });

    // 2. Flow runs: amount 30000 > 5000 → flags for manager
    const engine = createSyncFlowEngine(createTestFlowContext(store));
    engine.registerFlow(purchaseApprovalFlow);
    await engine.startFlow("purchase_approval", { id: record.id, amount: 30000 });

    const afterFlow = await store.get("purchase_request", record.id);
    expect(afterFlow.status).toBe("pending"); // Still pending!

    // 3. Manager manually approves (state machine validates)
    expect(transition(machine, "pending", "approve_purchase_request").allowed).toBe(true);
    await store.update("purchase_request", record.id, {
      status: "approved",
      approved_by: managerActor.id,
    });

    const final = await store.get("purchase_request", record.id);
    expect(final.status).toBe("approved");
    expect(final.approved_by).toBe("mgr-001");
  });

  test("reject → resubmit → flow auto-approves on second attempt", async () => {
    // 1. Create & submit
    const record = await store.create("purchase_request", {
      title: "Team Lunch",
      amount: 500,
      status: "draft",
    });
    await store.update("purchase_request", record.id, { status: "pending" });

    // 2. Manager rejects (state machine: pending → rejected ✓)
    expect(transition(machine, "pending", "reject_purchase_request").allowed).toBe(true);
    await store.update("purchase_request", record.id, { status: "rejected" });

    // 3. User resubmits (state machine: rejected → pending ✓)
    expect(transition(machine, "rejected", "submit_purchase_request").allowed).toBe(true);
    await store.update("purchase_request", record.id, { status: "pending" });

    // 4. Flow triggers again on resubmit → auto-approves (amount 500 <= 5000)
    const engine = createSyncFlowEngine(createTestFlowContext(store));
    engine.registerFlow(purchaseApprovalFlow);
    await engine.startFlow("purchase_approval", { id: record.id, amount: 500 });

    expect((await store.get("purchase_request", record.id)).status).toBe("approved");
  });

  test("state machine blocks invalid transitions regardless of flow", () => {
    // These transitions are impossible — state machine refuses them
    expect(transition(machine, "draft", "approve_purchase_request").allowed).toBe(false);
    expect(transition(machine, "approved", "submit_purchase_request").allowed).toBe(false);
    expect(transition(machine, "approved", "reject_purchase_request").allowed).toBe(false);

    // A flow cannot bypass the state machine — if it tried to call
    // approve_purchase_request on a draft record, the action handler
    // would reject it (status check in handler)
  });
});

// ══════════════════════════════════════════════════════════
// Part 4: Flow engine features
// ══════════════════════════════════════════════════════════

describe("Flow engine operational features", () => {
  test("flow instances are trackable by ID", async () => {
    const store = new InMemoryStore();
    await store.create("purchase_request", {
      id: "pr-track",
      title: "Track Me",
      amount: 100,
      status: "pending",
    });

    const engine = createSyncFlowEngine(createTestFlowContext(store));
    engine.registerFlow(purchaseApprovalFlow);

    const instance = await engine.startFlow(
      "purchase_approval",
      { id: "pr-track", amount: 100 },
      { instanceId: "flow-001" },
    );

    expect(instance.id).toBe("flow-001");
    expect(instance.flowName).toBe("purchase_approval");
    expect(instance.status).toBe("completed");
    expect(instance.startedAt).toBeInstanceOf(Date);
    expect(instance.completedAt).toBeInstanceOf(Date);

    // Query status by instance ID
    const status = await engine.getFlowStatus("flow-001");
    expect(status).not.toBeNull();
    expect(status!.status).toBe("completed");
  });

  test("flow fails gracefully when action errors", async () => {
    const store = new InMemoryStore();
    // Don't create the record — approve action will fail

    const engine = createSyncFlowEngine(createTestFlowContext(store));
    engine.registerFlow(purchaseApprovalFlow);

    const instance = await engine.startFlow("purchase_approval", {
      id: "nonexistent",
      amount: 100, // Would auto-approve, but record doesn't exist
    });

    expect(instance.status).toBe("failed");
    expect(instance.error).toBeDefined();
    expect(instance.error!.stepId).toBe("auto_approve");
  });

  test("unregistered flow throws clear error", async () => {
    const engine = createSyncFlowEngine(createTestFlowContext(new InMemoryStore()));
    await expect(engine.startFlow("nonexistent", {})).rejects.toThrow('"nonexistent" is not registered');
  });

});
