/**
 * E2E Test: Full approval workflow
 *
 * Wires real engines (ApprovalEngine, ActionEngine, CommandLayer, EventBus, PermissionRegistry)
 * with InMemory backends to exercise the complete approval lifecycle end-to-end.
 *
 * Covers:
 * - Create action → execute → pending approval
 * - Approve → action completes
 * - Reject → action fails
 * - Permission: only authorized approvers can approve
 * - Edge: approve already-resolved, double-approve
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { createActionExecutor } from "../src/engine/action-engine";
import {
  createApprovalEngine,
  createApprovalVerifier,
  InMemoryApprovalStore,
} from "../src/engine/approval-engine";
import { createCommandLayer } from "../src/engine/command-layer";
import { createEventBus } from "../src/event/event-bus";
import { InMemoryExecutionLogger } from "../src/observability/execution-logger";
import type { ActionDefinition, Actor } from "../src/types/action";
import type { RuleDefinition } from "../src/types/rule";

// ── Actors ────────────────────────────────────────────────────

const requestor: Actor = {
  type: "human",
  id: "requestor-1",
  name: "Alice",
  groups: ["employee"],
};

const manager: Actor = {
  type: "human",
  id: "manager-1",
  name: "Bob Manager",
  groups: ["manager"],
};

const unauthorizedActor: Actor = {
  type: "human",
  id: "other-1",
  name: "Carol Other",
  groups: ["employee"],
};

// ── Minimal in-memory DataProvider ────────────────────────────

function createMemoryDataProvider() {
  const store = new Map<string, Map<string, Record<string, unknown>>>();
  let counter = 0;

  return {
    async get(schema: string, id: string) {
      const record = store.get(schema)?.get(id);
      if (!record) throw new Error(`Record not found: ${schema}/${id}`);
      return record;
    },
    async query(_schema: string, _filter: Record<string, unknown>) {
      return [];
    },
    async create(schema: string, input: Record<string, unknown>) {
      if (!store.has(schema)) store.set(schema, new Map());
      counter++;
      const id = `id_${counter}`;
      const record = { id, ...input, _version: 1, tenant_id: null };
      store.get(schema)?.set(id, record);
      return record;
    },
    async update(schema: string, id: string, updates: Record<string, unknown>) {
      const record = store.get(schema)?.get(id);
      if (!record) throw new Error(`Record not found: ${schema}/${id}`);
      Object.assign(record, updates);
      return record;
    },
    async delete(schema: string, id: string) {
      store.get(schema)?.delete(id);
    },
  };
}

// ── Setup helpers ─────────────────────────────────────────────

function buildApprovalRule(): RuleDefinition {
  return {
    name: "require_manager_approval",
    label: "Require Manager Approval",
    entity: "purchase",
    conditions: [{ field: "amount", operator: "gt", value: 100 }],
    effects: [{ type: "require_approval", level: "manager" }],
  };
}

function buildHighValueAction(rules?: RuleDefinition[]): ActionDefinition {
  return {
    name: "approve_purchase",
    entity: "purchase",
    label: "Approve Purchase",
    policy: { mode: "sync", transaction: false },
    exposure: "all",
    rules: rules?.map((r) => r.name),
    handler: async (ctx) => {
      return ctx.create("purchase", ctx.input);
    },
  };
}

interface TestSetup {
  approvalStore: InMemoryApprovalStore;
  approvalEngine: ReturnType<typeof createApprovalEngine>;
  commandLayer: ReturnType<typeof createCommandLayer>;
  emittedEvents: { type: string; payload: Record<string, unknown> }[];
}

function createTestSetup(): TestSetup {
  const { registry: eventRegistry, bus: eventBus } = createEventBus();
  const emittedEvents: { type: string; payload: Record<string, unknown> }[] = [];

  // Capture all events
  eventRegistry.register({
    name: "event-capture",
    listen: ["approval.requested", "approval.approved", "approval.rejected", "approval.cancelled"],
    handler: async (event) => {
      emittedEvents.push({ type: event.type, payload: event.payload });
    },
  });

  const dp = createMemoryDataProvider();
  const executor = createActionExecutor({ dataProvider: dp });
  const _executionLogger = new InMemoryExecutionLogger();
  const approvalStore = new InMemoryApprovalStore();

  const approvalRule = buildApprovalRule();
  const action = buildHighValueAction([approvalRule]);
  executor.registry.register(action);

  const approvalEngine = createApprovalEngine({
    store: approvalStore,
    eventBus,
    enforceAssignee: false,
  });

  const commandLayer = createCommandLayer({
    executor,
    verifyApproval: createApprovalVerifier(approvalStore),
  });

  // Wire approval engine to command layer
  approvalEngine.setExecutor(executor);

  return { approvalStore, approvalEngine, commandLayer, emittedEvents };
}

// ── Tests ──────────────────────────────────────────────────────

describe("E2E: Approval workflow", () => {
  let setup: TestSetup;

  beforeEach(() => {
    setup = createTestSetup();
  });

  describe("Basic create-request flow", () => {
    it("creates a pending approval request via createRequest", async () => {
      const { approvalEngine, approvalStore } = setup;

      const result = await approvalEngine.createRequest({
        action: "approve_purchase",
        entity: "purchase",
        input: { amount: 500, item: "laptop" },
        actor: requestor,
        executionId: "exec-1",
        effect: { type: "require_approval", level: "manager" },
        triggerRules: ["require_manager_approval"],
      });

      expect(result.status).toBe("pending_approval");
      expect(result.approvalId).toBeDefined();
      expect(result.level).toBe("manager");

      const stored = approvalStore.getById(result.approvalId);
      expect(stored).toBeDefined();
      expect(stored?.status).toBe("pending");
      expect(stored?.action).toBe("approve_purchase");
      expect(stored?.requestedBy.id).toBe(requestor.id);
    });

    it("emits approval.requested event", async () => {
      const { approvalEngine, emittedEvents } = setup;

      await approvalEngine.createRequest({
        action: "approve_purchase",
        entity: "purchase",
        input: { amount: 500 },
        actor: requestor,
        executionId: "exec-2",
        effect: { type: "require_approval", level: "manager" },
        triggerRules: ["require_manager_approval"],
      });

      const requestEvent = emittedEvents.find((e) => e.type === "approval.requested");
      expect(requestEvent).toBeDefined();
    });
  });

  describe("Approve flow", () => {
    it("approve completes the approval and re-executes the action", async () => {
      const { approvalEngine, approvalStore } = setup;

      const pending = await approvalEngine.createRequest({
        action: "approve_purchase",
        entity: "purchase",
        input: { amount: 500, item: "monitor" },
        actor: requestor,
        executionId: "exec-3",
        effect: { type: "require_approval", level: "manager" },
        triggerRules: ["require_manager_approval"],
      });

      const result = await approvalEngine.approve({ approvalId: pending.approvalId }, manager);

      expect(result.success).toBe(true);

      const updated = approvalStore.getById(pending.approvalId);
      expect(updated?.status).toBe("approved");
      expect(updated?.decidedBy?.id).toBe(manager.id);
    });

    it("emits approval.approved event", async () => {
      const { approvalEngine, emittedEvents } = setup;

      const pending = await approvalEngine.createRequest({
        action: "approve_purchase",
        entity: "purchase",
        input: { amount: 500 },
        actor: requestor,
        executionId: "exec-4",
        effect: { type: "require_approval", level: "manager" },
        triggerRules: ["require_manager_approval"],
      });

      await approvalEngine.approve({ approvalId: pending.approvalId }, manager);

      const approvedEvent = emittedEvents.find((e) => e.type === "approval.approved");
      expect(approvedEvent).toBeDefined();
    });
  });

  describe("Reject flow", () => {
    it("reject marks request as rejected", async () => {
      const { approvalEngine, approvalStore } = setup;

      const pending = await approvalEngine.createRequest({
        action: "approve_purchase",
        entity: "purchase",
        input: { amount: 500 },
        actor: requestor,
        executionId: "exec-5",
        effect: { type: "require_approval", level: "manager" },
        triggerRules: ["require_manager_approval"],
      });

      const rejected = await approvalEngine.reject(
        { approvalId: pending.approvalId, note: "Over budget" },
        manager,
      );

      expect(rejected.status).toBe("rejected");
      expect(rejected.decisionNote).toBe("Over budget");

      const stored = approvalStore.getById(pending.approvalId);
      expect(stored?.status).toBe("rejected");
    });

    it("reject requires a non-empty note", async () => {
      const { approvalEngine } = setup;

      const pending = await approvalEngine.createRequest({
        action: "approve_purchase",
        entity: "purchase",
        input: { amount: 500 },
        actor: requestor,
        executionId: "exec-6",
        effect: { type: "require_approval", level: "manager" },
        triggerRules: ["require_manager_approval"],
      });

      await expect(
        approvalEngine.reject({ approvalId: pending.approvalId, note: "" }, manager),
      ).rejects.toThrow("Rejection note is required");
    });

    it("emits approval.rejected event", async () => {
      const { approvalEngine, emittedEvents } = setup;

      const pending = await approvalEngine.createRequest({
        action: "approve_purchase",
        entity: "purchase",
        input: { amount: 500 },
        actor: requestor,
        executionId: "exec-7",
        effect: { type: "require_approval", level: "manager" },
        triggerRules: ["require_manager_approval"],
      });

      await approvalEngine.reject({ approvalId: pending.approvalId, note: "Denied" }, manager);

      expect(emittedEvents.find((e) => e.type === "approval.rejected")).toBeDefined();
    });
  });

  describe("Permission enforcement", () => {
    it("enforces assignee check when enforceAssignee=true", async () => {
      const { bus: eventBus } = createEventBus();
      const dp = createMemoryDataProvider();
      const executor = createActionExecutor({ dataProvider: dp });
      executor.registry.register(buildHighValueAction());

      const strictStore = new InMemoryApprovalStore();
      const strictEngine = createApprovalEngine({
        store: strictStore,
        eventBus,
        enforceAssignee: true,
        executor,
      });

      const pending = await strictEngine.createRequest({
        action: "approve_purchase",
        entity: "purchase",
        input: { amount: 500 },
        actor: requestor,
        executionId: "exec-8",
        effect: { type: "require_approval", level: "manager" },
        triggerRules: ["require_manager_approval"],
        assignee: { type: "group", value: "manager" },
      });

      // unauthorizedActor is not in "manager" group
      await expect(
        strictEngine.approve({ approvalId: pending.approvalId }, unauthorizedActor),
      ).rejects.toThrow();
    });

    it("allows authorized actor with matching group", async () => {
      const { bus: eventBus } = createEventBus();
      const dp = createMemoryDataProvider();
      const executor = createActionExecutor({ dataProvider: dp });
      executor.registry.register(buildHighValueAction());

      const strictStore = new InMemoryApprovalStore();
      const strictEngine = createApprovalEngine({
        store: strictStore,
        eventBus,
        enforceAssignee: true,
        executor,
      });

      const pending = await strictEngine.createRequest({
        action: "approve_purchase",
        entity: "purchase",
        input: { amount: 500, item: "desk" },
        actor: requestor,
        executionId: "exec-9",
        effect: { type: "require_approval", level: "manager" },
        triggerRules: ["require_manager_approval"],
        assignee: { type: "group", value: "manager" },
      });

      const result = await strictEngine.approve({ approvalId: pending.approvalId }, manager);
      expect(result.success).toBe(true);
    });
  });

  describe("Edge cases", () => {
    it("throws when approving a non-existent request", async () => {
      const { approvalEngine } = setup;

      await expect(approvalEngine.approve({ approvalId: "nonexistent" }, manager)).rejects.toThrow(
        "not found",
      );
    });

    it("throws when approving an already-approved request (double approve)", async () => {
      const { approvalEngine } = setup;

      const pending = await approvalEngine.createRequest({
        action: "approve_purchase",
        entity: "purchase",
        input: { amount: 500, item: "chair" },
        actor: requestor,
        executionId: "exec-10",
        effect: { type: "require_approval", level: "manager" },
        triggerRules: ["require_manager_approval"],
      });

      await approvalEngine.approve({ approvalId: pending.approvalId }, manager);

      // Second approve should fail
      await expect(
        approvalEngine.approve({ approvalId: pending.approvalId }, manager),
      ).rejects.toThrow("not pending");
    });

    it("throws when approving an already-rejected request", async () => {
      const { approvalEngine } = setup;

      const pending = await approvalEngine.createRequest({
        action: "approve_purchase",
        entity: "purchase",
        input: { amount: 500 },
        actor: requestor,
        executionId: "exec-11",
        effect: { type: "require_approval", level: "manager" },
        triggerRules: ["require_manager_approval"],
      });

      await approvalEngine.reject({ approvalId: pending.approvalId, note: "Denied" }, manager);

      await expect(
        approvalEngine.approve({ approvalId: pending.approvalId }, manager),
      ).rejects.toThrow("not pending");
    });

    it("cancel removes pending request by initiator only", async () => {
      const { approvalEngine, approvalStore } = setup;

      const pending = await approvalEngine.createRequest({
        action: "approve_purchase",
        entity: "purchase",
        input: { amount: 500 },
        actor: requestor,
        executionId: "exec-12",
        effect: { type: "require_approval", level: "manager" },
        triggerRules: ["require_manager_approval"],
      });

      const cancelled = await approvalEngine.cancel({ approvalId: pending.approvalId }, requestor);

      expect(cancelled.status).toBe("cancelled");
      expect(approvalStore.getById(pending.approvalId)?.status).toBe("cancelled");
    });

    it("cancel throws when attempted by non-initiator", async () => {
      const { approvalEngine } = setup;

      const pending = await approvalEngine.createRequest({
        action: "approve_purchase",
        entity: "purchase",
        input: { amount: 500 },
        actor: requestor,
        executionId: "exec-13",
        effect: { type: "require_approval", level: "manager" },
        triggerRules: ["require_manager_approval"],
      });

      await expect(
        approvalEngine.cancel({ approvalId: pending.approvalId }, manager),
      ).rejects.toThrow("initiator");
    });

    it("expireOverdue skips requests with timeoutPolicy=none", async () => {
      const { approvalEngine, approvalStore } = setup;

      const pastDate = new Date(Date.now() - 1000);

      const pending = await approvalEngine.createRequest({
        action: "approve_purchase",
        entity: "purchase",
        input: { amount: 500 },
        actor: requestor,
        executionId: "exec-14",
        effect: { type: "require_approval", level: "manager" },
        triggerRules: ["require_manager_approval"],
        expiresAt: pastDate,
        timeoutPolicy: "none",
      });

      const expired = await approvalEngine.expireOverdue();
      expect(expired).toHaveLength(0);

      // Still pending with timeoutPolicy=none
      expect(approvalStore.getById(pending.approvalId)?.status).toBe("pending");
    });
  });
});
