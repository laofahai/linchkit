import { beforeEach, describe, expect, it } from "bun:test";
import {
  type ActionExecutor,
  createActionExecutor,
  type DataProvider,
} from "../src/engine/action-engine";
import type { ApprovalEngine } from "../src/engine/approval-engine";
import { createApprovalEngine, InMemoryApprovalStore } from "../src/engine/approval-engine";
import { type CommandLayer, createCommandLayer } from "../src/engine/command-layer";
import { createEventBus, type EventBus } from "../src/engine/event-bus";
import { InMemoryExecutionLogger } from "../src/engine/execution-logger";
import { evaluateRules } from "../src/engine/rule-engine";
import type { ActionDefinition, Actor } from "../src/types/action";
import type { ApprovalRequest } from "../src/types/approval";
import type { RuleDefinition } from "../src/types/rule";

// ── Test fixtures ───────────────────────────────────────

const defaultActor: Actor = {
  type: "human",
  id: "user-1",
  name: "Alice",
  groups: ["employee"],
};

const managerActor: Actor = {
  type: "human",
  id: "manager-1",
  name: "Bob Manager",
  groups: ["manager"],
};

const otherActor: Actor = {
  type: "human",
  id: "user-2",
  name: "Dave",
  groups: ["employee"],
};

// ── In-memory DataProvider ──────────────────────────────

function createMemoryDataProvider(): DataProvider {
  const store = new Map<string, Map<string, Record<string, unknown>>>();

  function getTable(schema: string): Map<string, Record<string, unknown>> {
    if (!store.has(schema)) {
      store.set(schema, new Map());
    }
    const table = store.get(schema);
    if (!table) throw new Error(`Unreachable: store missing key ${schema}`);
    return table;
  }

  return {
    async get(schema, id) {
      const table = getTable(schema);
      const record = table.get(id);
      if (!record) throw new Error(`Record not found: ${schema}/${id}`);
      return record;
    },
    async query(schema, filter) {
      const table = getTable(schema);
      return Array.from(table.values()).filter((record) => {
        return Object.entries(filter).every(([k, v]) => record[k] === v);
      });
    },
    async create(schema, data) {
      const table = getTable(schema);
      const id = (data.id as string) || `id_${table.size + 1}`;
      const record = { ...data, id };
      table.set(id, record);
      return record;
    },
    async update(schema, id, data) {
      const table = getTable(schema);
      const existing = table.get(id);
      if (!existing) throw new Error(`Record not found: ${schema}/${id}`);
      const updated = { ...existing, ...data };
      table.set(id, updated);
      return updated;
    },
    async delete(schema, id) {
      const table = getTable(schema);
      table.delete(id);
    },
  };
}

// ── Action fixtures ─────────────────────────────────────

const submitRequestAction: ActionDefinition = {
  name: "submit_request",
  schema: "purchase_request",
  label: "Submit Purchase Request",
  input: {
    title: { type: "string", required: true },
    amount: { type: "number", required: true },
  },
  policy: { mode: "sync", transaction: true },
  handler: async (ctx) => {
    const record = await ctx.create("purchase_request", {
      title: ctx.input.title,
      amount: ctx.input.amount,
      status: "submitted",
    });
    return record;
  },
};

// ── Rule fixtures ───────────────────────────────────────

const amountApprovalRule: RuleDefinition = {
  name: "amount_check",
  label: "Large purchase needs manager approval",
  trigger: { action: "submit_request" },
  condition: {
    field: "target.amount",
    operator: "gt",
    value: 10000,
  },
  effect: {
    type: "require_approval",
    level: "manager",
    message: "Purchase over 10,000 requires manager approval",
  },
};

const largeAmountDirectorRule: RuleDefinition = {
  name: "large_amount_check",
  label: "Very large purchase needs director approval",
  trigger: { action: "submit_request" },
  condition: {
    field: "target.amount",
    operator: "gt",
    value: 50000,
  },
  effect: {
    type: "require_approval",
    level: "director",
    message: "Purchase over 50,000 requires director approval",
  },
};

const blockRule: RuleDefinition = {
  name: "max_amount_block",
  label: "Block purchases over 1M",
  priority: 100,
  trigger: { action: "submit_request" },
  condition: {
    field: "target.amount",
    operator: "gt",
    value: 1000000,
  },
  effect: {
    type: "block",
    message: "Purchases over 1,000,000 are not allowed",
  },
};

// ── Tests ───────────────────────────────────────────────

describe("InMemoryApprovalStore", () => {
  let store: InMemoryApprovalStore;

  beforeEach(() => {
    store = new InMemoryApprovalStore();
  });

  it("creates and retrieves a request", () => {
    const now = new Date();
    const request: ApprovalRequest = {
      id: "ap-1",
      action: "submit_request",
      schema: "purchase_request",
      input: { amount: 15000 },
      level: "manager",
      reason: "Amount exceeds 10,000",
      triggerRules: ["amount_check"],
      requestedBy: defaultActor,
      assignee: { type: "role", value: "manager" },
      status: "pending",
      timeoutPolicy: "none",
      originalExecutionId: "exec-1",
      createdAt: now,
      updatedAt: now,
    };

    store.create(request);
    const retrieved = store.getById("ap-1");

    expect(retrieved).toBeDefined();
    expect(retrieved?.id).toBe("ap-1");
    expect(retrieved?.status).toBe("pending");
  });

  it("updates a request", () => {
    const now = new Date();
    const request: ApprovalRequest = {
      id: "ap-2",
      action: "submit_request",
      schema: "purchase_request",
      input: { amount: 15000 },
      level: "manager",
      reason: "test",
      triggerRules: ["amount_check"],
      requestedBy: defaultActor,
      assignee: { type: "role", value: "manager" },
      status: "pending",
      timeoutPolicy: "none",
      originalExecutionId: "exec-2",
      createdAt: now,
      updatedAt: now,
    };

    store.create(request);
    const updated = store.update("ap-2", { status: "approved", decidedBy: managerActor });

    expect(updated?.status).toBe("approved");
    expect(updated?.decidedBy?.id).toBe("manager-1");
  });

  it("queries by status", () => {
    const now = new Date();
    const base = {
      action: "submit_request",
      schema: "purchase_request",
      input: {},
      level: "manager",
      reason: "test",
      triggerRules: ["r1"],
      requestedBy: defaultActor,
      assignee: { type: "role" as const, value: "manager" },
      timeoutPolicy: "none" as const,
      originalExecutionId: "exec",
      createdAt: now,
      updatedAt: now,
    };

    store.create({ ...base, id: "ap-a", status: "pending" });
    store.create({ ...base, id: "ap-b", status: "pending" });
    store.create({ ...base, id: "ap-c", status: "approved" });

    const pending = store.query({ status: "pending" });
    expect(pending).toHaveLength(2);

    const approved = store.query({ status: "approved" });
    expect(approved).toHaveLength(1);
  });

  it("finds expired requests", () => {
    const past = new Date(Date.now() - 60000);
    const future = new Date(Date.now() + 60000);
    const now = new Date();
    const base = {
      action: "submit_request",
      input: {},
      level: "manager",
      reason: "test",
      triggerRules: ["r1"],
      requestedBy: defaultActor,
      assignee: { type: "role" as const, value: "manager" },
      timeoutPolicy: "reject" as const,
      originalExecutionId: "exec",
      createdAt: now,
      updatedAt: now,
    };

    store.create({ ...base, id: "ap-expired", status: "pending", expiresAt: past });
    store.create({ ...base, id: "ap-not-expired", status: "pending", expiresAt: future });
    store.create({ ...base, id: "ap-no-expiry", status: "pending" });

    const expired = store.getExpired();
    expect(expired).toHaveLength(1);
    expect(expired[0].id).toBe("ap-expired");
  });
});

describe("ApprovalEngine", () => {
  let store: InMemoryApprovalStore;
  let engine: ApprovalEngine;
  let dataProvider: DataProvider;
  let executor: ActionExecutor;
  let eventBus: EventBus;

  beforeEach(() => {
    store = new InMemoryApprovalStore();
    dataProvider = createMemoryDataProvider();
    const executionLogger = new InMemoryExecutionLogger();
    executor = createActionExecutor({ dataProvider, executionLogger });
    executor.registry.register(submitRequestAction);

    const { bus } = createEventBus();
    eventBus = bus;

    engine = createApprovalEngine({ store, eventBus, executor });
  });

  it("creates an approval request", async () => {
    const result = await engine.createRequest({
      action: "submit_request",
      schema: "purchase_request",
      input: { title: "Laptop", amount: 15000 },
      actor: defaultActor,
      executionId: "exec-100",
      effect: {
        type: "require_approval",
        level: "manager",
        message: "Purchase over 10,000 requires manager approval",
      },
      triggerRules: ["amount_check"],
    });

    expect(result.status).toBe("pending_approval");
    expect(result.approvalId).toBeDefined();
    expect(result.level).toBe("manager");

    // Check stored request
    const stored = store.getById(result.approvalId);
    expect(stored).toBeDefined();
    expect(stored?.status).toBe("pending");
    expect(stored?.action).toBe("submit_request");
    expect(stored?.triggerRules).toEqual(["amount_check"]);
  });

  it("emits approval.requested event on creation", async () => {
    await engine.createRequest({
      action: "submit_request",
      schema: "purchase_request",
      input: { title: "Laptop", amount: 15000 },
      actor: defaultActor,
      executionId: "exec-101",
      effect: { type: "require_approval", level: "manager" },
      triggerRules: ["amount_check"],
    });

    const events = eventBus.getEmittedEvents();
    expect(events.length).toBeGreaterThanOrEqual(1);
    const approvalEvent = events.find((e) => e.type === "approval.requested");
    expect(approvalEvent).toBeDefined();
    expect(approvalEvent?.payload.level).toBe("manager");
  });

  it("approves and re-executes the original action", async () => {
    const createResult = await engine.createRequest({
      action: "submit_request",
      schema: "purchase_request",
      input: { title: "Laptop", amount: 15000 },
      actor: defaultActor,
      executionId: "exec-200",
      effect: { type: "require_approval", level: "manager" },
      triggerRules: ["amount_check"],
    });

    const approveResult = await engine.approve(
      { approvalId: createResult.approvalId },
      managerActor,
    );

    expect(approveResult.success).toBe(true);
    expect(approveResult.executionId).toBeDefined();

    // Check the approval request was updated
    const stored = store.getById(createResult.approvalId);
    expect(stored?.status).toBe("approved");
    expect(stored?.decidedBy?.id).toBe("manager-1");
    expect(stored?.executionId).toBe(approveResult.executionId);
  });

  it("emits approval.approved event on approve", async () => {
    const createResult = await engine.createRequest({
      action: "submit_request",
      schema: "purchase_request",
      input: { title: "Laptop", amount: 15000 },
      actor: defaultActor,
      executionId: "exec-201",
      effect: { type: "require_approval", level: "manager" },
      triggerRules: ["amount_check"],
    });

    await engine.approve({ approvalId: createResult.approvalId }, managerActor);

    const events = eventBus.getEmittedEvents();
    const approvedEvent = events.find((e) => e.type === "approval.approved");
    expect(approvedEvent).toBeDefined();
  });

  it("rejects an approval request with a note", async () => {
    const createResult = await engine.createRequest({
      action: "submit_request",
      schema: "purchase_request",
      input: { title: "Laptop", amount: 15000 },
      actor: defaultActor,
      executionId: "exec-300",
      effect: { type: "require_approval", level: "manager" },
      triggerRules: ["amount_check"],
    });

    const rejected = await engine.reject(
      { approvalId: createResult.approvalId, note: "Budget exceeded for Q4" },
      managerActor,
    );

    expect(rejected.status).toBe("rejected");
    expect(rejected.decisionNote).toBe("Budget exceeded for Q4");
    expect(rejected.decidedBy?.id).toBe("manager-1");
  });

  it("emits approval.rejected event on reject", async () => {
    const createResult = await engine.createRequest({
      action: "submit_request",
      schema: "purchase_request",
      input: { title: "Laptop", amount: 15000 },
      actor: defaultActor,
      executionId: "exec-301",
      effect: { type: "require_approval", level: "manager" },
      triggerRules: ["amount_check"],
    });

    await engine.reject({ approvalId: createResult.approvalId, note: "No budget" }, managerActor);

    const events = eventBus.getEmittedEvents();
    const rejectedEvent = events.find((e) => e.type === "approval.rejected");
    expect(rejectedEvent).toBeDefined();
  });

  it("allows initiator to cancel own request", async () => {
    const createResult = await engine.createRequest({
      action: "submit_request",
      schema: "purchase_request",
      input: { title: "Laptop", amount: 15000 },
      actor: defaultActor,
      executionId: "exec-400",
      effect: { type: "require_approval", level: "manager" },
      triggerRules: ["amount_check"],
    });

    const cancelled = await engine.cancel({ approvalId: createResult.approvalId }, defaultActor);

    expect(cancelled.status).toBe("cancelled");
  });

  it("prevents non-initiator from cancelling", async () => {
    const createResult = await engine.createRequest({
      action: "submit_request",
      schema: "purchase_request",
      input: { title: "Laptop", amount: 15000 },
      actor: defaultActor,
      executionId: "exec-401",
      effect: { type: "require_approval", level: "manager" },
      triggerRules: ["amount_check"],
    });

    expect(engine.cancel({ approvalId: createResult.approvalId }, otherActor)).rejects.toThrow(
      "Only the original initiator can cancel",
    );
  });

  it("emits approval.cancelled event on cancel", async () => {
    const createResult = await engine.createRequest({
      action: "submit_request",
      schema: "purchase_request",
      input: { title: "Laptop", amount: 15000 },
      actor: defaultActor,
      executionId: "exec-402",
      effect: { type: "require_approval", level: "manager" },
      triggerRules: ["amount_check"],
    });

    await engine.cancel({ approvalId: createResult.approvalId }, defaultActor);

    const events = eventBus.getEmittedEvents();
    const cancelledEvent = events.find((e) => e.type === "approval.cancelled");
    expect(cancelledEvent).toBeDefined();
  });

  it("prevents approving a non-pending request", async () => {
    const createResult = await engine.createRequest({
      action: "submit_request",
      schema: "purchase_request",
      input: { title: "Laptop", amount: 15000 },
      actor: defaultActor,
      executionId: "exec-500",
      effect: { type: "require_approval", level: "manager" },
      triggerRules: ["amount_check"],
    });

    // Reject first
    await engine.reject({ approvalId: createResult.approvalId, note: "No" }, managerActor);

    // Try to approve the rejected request — should throw
    expect(engine.approve({ approvalId: createResult.approvalId }, managerActor)).rejects.toThrow(
      "not pending",
    );
  });

  it("prevents rejecting a non-pending request", async () => {
    const createResult = await engine.createRequest({
      action: "submit_request",
      schema: "purchase_request",
      input: { title: "Laptop", amount: 15000 },
      actor: defaultActor,
      executionId: "exec-501",
      effect: { type: "require_approval", level: "manager" },
      triggerRules: ["amount_check"],
    });

    // Cancel first
    await engine.cancel({ approvalId: createResult.approvalId }, defaultActor);

    // Try to reject the cancelled request
    expect(
      engine.reject({ approvalId: createResult.approvalId, note: "Too late" }, managerActor),
    ).rejects.toThrow("not pending");
  });

  it("expires overdue requests with reject policy", async () => {
    const past = new Date(Date.now() - 60000);

    await engine.createRequest({
      action: "submit_request",
      schema: "purchase_request",
      input: { title: "Laptop", amount: 15000 },
      actor: defaultActor,
      executionId: "exec-600",
      effect: { type: "require_approval", level: "manager" },
      triggerRules: ["amount_check"],
      expiresAt: past,
      timeoutPolicy: "reject",
    });

    const expired = await engine.expireOverdue();
    expect(expired).toHaveLength(1);
    expect(expired[0].status).toBe("expired");
  });

  it("does not expire requests with 'none' timeout policy", async () => {
    const past = new Date(Date.now() - 60000);

    await engine.createRequest({
      action: "submit_request",
      schema: "purchase_request",
      input: { title: "Laptop", amount: 15000 },
      actor: defaultActor,
      executionId: "exec-601",
      effect: { type: "require_approval", level: "manager" },
      triggerRules: ["amount_check"],
      expiresAt: past,
      timeoutPolicy: "none",
    });

    const expired = await engine.expireOverdue();
    expect(expired).toHaveLength(0);
  });

  it("emits approval.expired event on expire", async () => {
    const past = new Date(Date.now() - 60000);

    await engine.createRequest({
      action: "submit_request",
      schema: "purchase_request",
      input: { title: "Laptop", amount: 15000 },
      actor: defaultActor,
      executionId: "exec-602",
      effect: { type: "require_approval", level: "manager" },
      triggerRules: ["amount_check"],
      expiresAt: past,
      timeoutPolicy: "reject",
    });

    await engine.expireOverdue();

    const events = eventBus.getEmittedEvents();
    const expiredEvent = events.find((e) => e.type === "approval.expired");
    expect(expiredEvent).toBeDefined();
  });
});

describe("Rule Engine + Approval Integration", () => {
  it("rule evaluation returns require_approval for matching condition", async () => {
    const rules = [amountApprovalRule];
    const input = {
      target: { amount: 15000, title: "Laptop" },
      actor: { type: "human", id: "user-1", groups: ["employee"] },
    };

    const result = await evaluateRules(rules, input);

    expect(result.triggered).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.requiredApproval).toBeDefined();
    expect(result.requiredApproval?.level).toBe("manager");
  });

  it("does not trigger approval for small amounts", async () => {
    const rules = [amountApprovalRule];
    const input = {
      target: { amount: 5000, title: "Mouse" },
      actor: { type: "human", id: "user-1", groups: ["employee"] },
    };

    const result = await evaluateRules(rules, input);

    expect(result.triggered).toBe(false);
    expect(result.requiredApproval).toBeNull();
  });

  it("multiple rules — highest approval level wins", async () => {
    const rules = [amountApprovalRule, largeAmountDirectorRule];
    const input = {
      target: { amount: 60000, title: "Server" },
      actor: { type: "human", id: "user-1", groups: ["employee"] },
    };

    const result = await evaluateRules(rules, input);

    expect(result.triggered).toBe(true);
    expect(result.requiredApproval).toBeDefined();
    // Director rank (3) > Manager rank (2)
    expect(result.requiredApproval?.level).toBe("director");
  });

  it("block takes priority over require_approval", async () => {
    const rules = [blockRule, amountApprovalRule, largeAmountDirectorRule];
    const input = {
      target: { amount: 2000000, title: "Yacht" },
      actor: { type: "human", id: "user-1", groups: ["employee"] },
    };

    const result = await evaluateRules(rules, input);

    // Block has priority 100 so it's evaluated first
    expect(result.blocked).toBe(true);
    expect(result.blockReasons.length).toBeGreaterThan(0);
  });

  it("end-to-end: rule triggers approval → create request → approve → re-execute", async () => {
    const store = new InMemoryApprovalStore();
    const dataProvider = createMemoryDataProvider();
    const executionLogger = new InMemoryExecutionLogger();
    const executor = createActionExecutor({ dataProvider, executionLogger });
    executor.registry.register(submitRequestAction);

    const { bus } = createEventBus();
    const approvalEngine = createApprovalEngine({ store, eventBus: bus, executor });

    // Step 1: Evaluate rules
    const ruleResult = await evaluateRules([amountApprovalRule], {
      target: { amount: 15000, title: "Laptop" },
      actor: { type: defaultActor.type, id: defaultActor.id, groups: defaultActor.groups },
    });

    expect(ruleResult.requiredApproval).not.toBeNull();

    // Step 2: Create approval request (instead of executing action)
    const pendingResult = await approvalEngine.createRequest({
      action: "submit_request",
      schema: "purchase_request",
      input: { title: "Laptop", amount: 15000 },
      actor: defaultActor,
      executionId: "exec-e2e-1",
      // biome-ignore lint/style/noNonNullAssertion: test asserts non-null above
      effect: ruleResult.requiredApproval!,
      triggerRules: ruleResult.results
        .filter((r) => r.triggered && r.effect?.type === "require_approval")
        .map((r) => r.rule),
    });

    expect(pendingResult.status).toBe("pending_approval");

    // Step 3: Approve the request → re-executes the action
    const approveResult = await approvalEngine.approve(
      { approvalId: pendingResult.approvalId },
      managerActor,
    );

    expect(approveResult.success).toBe(true);

    // Verify the approval request is updated
    const stored = store.getById(pendingResult.approvalId);
    expect(stored?.status).toBe("approved");
    expect(stored?.executionId).toBe(approveResult.executionId);

    // Verify events were emitted
    const events = bus.getEmittedEvents();
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain("approval.requested");
    expect(eventTypes).toContain("approval.approved");
  });

  it("end-to-end: rule triggers approval → reject → no execution", async () => {
    const store = new InMemoryApprovalStore();
    const dataProvider = createMemoryDataProvider();
    const executor = createActionExecutor({ dataProvider });
    executor.registry.register(submitRequestAction);

    const { bus } = createEventBus();
    const approvalEngine = createApprovalEngine({ store, eventBus: bus, executor });

    // Evaluate rules
    const ruleResult = await evaluateRules([amountApprovalRule], {
      target: { amount: 15000, title: "Laptop" },
      actor: { type: defaultActor.type, id: defaultActor.id, groups: defaultActor.groups },
    });

    // Create approval request
    const pendingResult = await approvalEngine.createRequest({
      action: "submit_request",
      schema: "purchase_request",
      input: { title: "Laptop", amount: 15000 },
      actor: defaultActor,
      executionId: "exec-e2e-2",
      // biome-ignore lint/style/noNonNullAssertion: test asserts non-null above
      effect: ruleResult.requiredApproval!,
      triggerRules: ["amount_check"],
    });

    // Reject the request
    const rejected = await approvalEngine.reject(
      { approvalId: pendingResult.approvalId, note: "No budget this quarter" },
      managerActor,
    );

    expect(rejected.status).toBe("rejected");
    expect(rejected.decisionNote).toBe("No budget this quarter");

    // Verify no execution happened (no executionId set)
    expect(rejected.executionId).toBeUndefined();

    // Verify events
    const events = bus.getEmittedEvents();
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain("approval.requested");
    expect(eventTypes).toContain("approval.rejected");
    expect(eventTypes).not.toContain("approval.approved");
  });
});

describe("ApprovalEngine — assignee authorization", () => {
  let store: InMemoryApprovalStore;
  let dataProvider: DataProvider;
  let executor: ActionExecutor;
  let eventBus: EventBus;

  beforeEach(() => {
    store = new InMemoryApprovalStore();
    dataProvider = createMemoryDataProvider();
    const executionLogger = new InMemoryExecutionLogger();
    executor = createActionExecutor({ dataProvider, executionLogger });
    executor.registry.register(submitRequestAction);

    const { bus } = createEventBus();
    eventBus = bus;
  });

  it("authorized user-assignee approve succeeds when enforceAssignee is true", async () => {
    const engine = createApprovalEngine({ store, eventBus, executor, enforceAssignee: true });

    const createResult = await engine.createRequest({
      action: "submit_request",
      schema: "purchase_request",
      input: { title: "Laptop", amount: 15000 },
      actor: defaultActor,
      executionId: "exec-auth-1",
      effect: { type: "require_approval", level: "manager" },
      triggerRules: ["amount_check"],
      assignee: { type: "user", value: "manager-1" },
    });

    // managerActor.id === "manager-1" matches assignee.value
    const result = await engine.approve({ approvalId: createResult.approvalId }, managerActor);
    expect(result.success).toBe(true);
  });

  it("unauthorized user-assignee approve fails when enforceAssignee is true", async () => {
    const engine = createApprovalEngine({ store, eventBus, executor, enforceAssignee: true });

    const createResult = await engine.createRequest({
      action: "submit_request",
      schema: "purchase_request",
      input: { title: "Laptop", amount: 15000 },
      actor: defaultActor,
      executionId: "exec-auth-2",
      effect: { type: "require_approval", level: "manager" },
      triggerRules: ["amount_check"],
      assignee: { type: "user", value: "manager-1" },
    });

    // otherActor.id === "user-2" does NOT match assignee.value "manager-1"
    await expect(
      engine.approve({ approvalId: createResult.approvalId }, otherActor),
    ).rejects.toThrow("not the assigned user");
  });

  it("authorized group-assignee approve succeeds when enforceAssignee is true", async () => {
    const engine = createApprovalEngine({ store, eventBus, executor, enforceAssignee: true });

    const createResult = await engine.createRequest({
      action: "submit_request",
      schema: "purchase_request",
      input: { title: "Laptop", amount: 15000 },
      actor: defaultActor,
      executionId: "exec-auth-3",
      effect: { type: "require_approval", level: "manager" },
      triggerRules: ["amount_check"],
      assignee: { type: "group", value: "manager" },
    });

    // managerActor.groups includes "manager"
    const result = await engine.approve({ approvalId: createResult.approvalId }, managerActor);
    expect(result.success).toBe(true);
  });

  it("unauthorized group-assignee approve fails when enforceAssignee is true", async () => {
    const engine = createApprovalEngine({ store, eventBus, executor, enforceAssignee: true });

    const createResult = await engine.createRequest({
      action: "submit_request",
      schema: "purchase_request",
      input: { title: "Laptop", amount: 15000 },
      actor: defaultActor,
      executionId: "exec-auth-4",
      effect: { type: "require_approval", level: "manager" },
      triggerRules: ["amount_check"],
      assignee: { type: "group", value: "manager" },
    });

    // defaultActor.groups is ["employee"], not "manager"
    await expect(
      engine.approve({ approvalId: createResult.approvalId }, defaultActor),
    ).rejects.toThrow("not a member of assigned group");
  });

  it("unauthorized reject fails when enforceAssignee is true", async () => {
    const engine = createApprovalEngine({ store, eventBus, executor, enforceAssignee: true });

    const createResult = await engine.createRequest({
      action: "submit_request",
      schema: "purchase_request",
      input: { title: "Laptop", amount: 15000 },
      actor: defaultActor,
      executionId: "exec-auth-5",
      effect: { type: "require_approval", level: "manager" },
      triggerRules: ["amount_check"],
      assignee: { type: "user", value: "manager-1" },
    });

    // otherActor is not the assigned user
    await expect(
      engine.reject({ approvalId: createResult.approvalId, note: "No budget" }, otherActor),
    ).rejects.toThrow("not the assigned user");
  });

  it("skips assignee check when enforceAssignee is false (default)", async () => {
    const engine = createApprovalEngine({ store, eventBus, executor });

    const createResult = await engine.createRequest({
      action: "submit_request",
      schema: "purchase_request",
      input: { title: "Laptop", amount: 15000 },
      actor: defaultActor,
      executionId: "exec-auth-6",
      effect: { type: "require_approval", level: "manager" },
      triggerRules: ["amount_check"],
      assignee: { type: "user", value: "manager-1" },
    });

    // otherActor doesn't match, but enforceAssignee is false so it should succeed
    const result = await engine.approve({ approvalId: createResult.approvalId }, otherActor);
    expect(result.success).toBe(true);
  });
});

describe("ApprovalEngine — rejection note validation", () => {
  let store: InMemoryApprovalStore;
  let engine: ApprovalEngine;

  beforeEach(() => {
    store = new InMemoryApprovalStore();
    engine = createApprovalEngine({ store });
  });

  it("rejects with empty note throws error", async () => {
    const createResult = await engine.createRequest({
      action: "submit_request",
      schema: "purchase_request",
      input: { title: "Laptop", amount: 15000 },
      actor: defaultActor,
      executionId: "exec-note-1",
      effect: { type: "require_approval", level: "manager" },
      triggerRules: ["amount_check"],
    });

    await expect(
      engine.reject({ approvalId: createResult.approvalId, note: "" }, managerActor),
    ).rejects.toThrow("Rejection note is required");
  });

  it("rejects with whitespace-only note throws error", async () => {
    const createResult = await engine.createRequest({
      action: "submit_request",
      schema: "purchase_request",
      input: { title: "Laptop", amount: 15000 },
      actor: defaultActor,
      executionId: "exec-note-2",
      effect: { type: "require_approval", level: "manager" },
      triggerRules: ["amount_check"],
    });

    await expect(
      engine.reject({ approvalId: createResult.approvalId, note: "   " }, managerActor),
    ).rejects.toThrow("Rejection note is required");
  });
});

describe("ApprovalEngine — expiration checks", () => {
  let store: InMemoryApprovalStore;
  let engine: ApprovalEngine;
  let executor: ActionExecutor;

  beforeEach(() => {
    store = new InMemoryApprovalStore();
    const dataProvider = createMemoryDataProvider();
    const executionLogger = new InMemoryExecutionLogger();
    executor = createActionExecutor({ dataProvider, executionLogger });
    executor.registry.register(submitRequestAction);
    engine = createApprovalEngine({ store, executor });
  });

  it("rejects approve on expired request", async () => {
    const past = new Date(Date.now() - 60000);

    const createResult = await engine.createRequest({
      action: "submit_request",
      schema: "purchase_request",
      input: { title: "Laptop", amount: 15000 },
      actor: defaultActor,
      executionId: "exec-exp-1",
      effect: { type: "require_approval", level: "manager" },
      triggerRules: ["amount_check"],
      expiresAt: past,
    });

    await expect(
      engine.approve({ approvalId: createResult.approvalId }, managerActor),
    ).rejects.toThrow("Approval request has expired");
  });

  it("rejects reject on expired request", async () => {
    const past = new Date(Date.now() - 60000);

    const createResult = await engine.createRequest({
      action: "submit_request",
      schema: "purchase_request",
      input: { title: "Laptop", amount: 15000 },
      actor: defaultActor,
      executionId: "exec-exp-2",
      effect: { type: "require_approval", level: "manager" },
      triggerRules: ["amount_check"],
      expiresAt: past,
    });

    await expect(
      engine.reject({ approvalId: createResult.approvalId, note: "Too late" }, managerActor),
    ).rejects.toThrow("Approval request has expired");
  });

  it("rejects cancel on expired request", async () => {
    const past = new Date(Date.now() - 60000);

    const createResult = await engine.createRequest({
      action: "submit_request",
      schema: "purchase_request",
      input: { title: "Laptop", amount: 15000 },
      actor: defaultActor,
      executionId: "exec-exp-3",
      effect: { type: "require_approval", level: "manager" },
      triggerRules: ["amount_check"],
      expiresAt: past,
    });

    await expect(
      engine.cancel({ approvalId: createResult.approvalId }, defaultActor),
    ).rejects.toThrow("Approval request has expired");
  });

  it("allows approve on non-expired request", async () => {
    const future = new Date(Date.now() + 60000);

    const createResult = await engine.createRequest({
      action: "submit_request",
      schema: "purchase_request",
      input: { title: "Laptop", amount: 15000 },
      actor: defaultActor,
      executionId: "exec-exp-4",
      effect: { type: "require_approval", level: "manager" },
      triggerRules: ["amount_check"],
      expiresAt: future,
    });

    const result = await engine.approve({ approvalId: createResult.approvalId }, managerActor);
    expect(result.success).toBe(true);
  });
});

describe("ApprovalEngine — CommandLayer re-execution", () => {
  let store: InMemoryApprovalStore;
  let dataProvider: DataProvider;
  let executor: ActionExecutor;
  let commandLayer: CommandLayer;
  let eventBus: EventBus;

  beforeEach(() => {
    store = new InMemoryApprovalStore();
    dataProvider = createMemoryDataProvider();
    const executionLogger = new InMemoryExecutionLogger();
    executor = createActionExecutor({ dataProvider, executionLogger });
    executor.registry.register(submitRequestAction);

    commandLayer = createCommandLayer({ executor });
    const { bus } = createEventBus();
    eventBus = bus;
  });

  it("re-executes through CommandLayer when available", async () => {
    const engine = createApprovalEngine({ store, eventBus, commandLayer });

    const createResult = await engine.createRequest({
      action: "submit_request",
      schema: "purchase_request",
      input: { title: "Laptop", amount: 15000 },
      actor: defaultActor,
      executionId: "exec-cl-1",
      effect: { type: "require_approval", level: "manager" },
      triggerRules: ["amount_check"],
    });

    const result = await engine.approve({ approvalId: createResult.approvalId }, managerActor);

    expect(result.success).toBe(true);
    expect(result.executionId).toBeDefined();

    // Verify approval request was updated with execution result
    const stored = store.getById(createResult.approvalId);
    expect(stored?.status).toBe("approved");
    expect(stored?.executionId).toBe(result.executionId);
  });

  it("pre/tenant/pre-action/post-action slots fire on re-execution", async () => {
    const slotsExecuted: string[] = [];

    commandLayer.use({
      name: "test_pre",
      slot: "pre",
      handler: async (_ctx, next) => {
        slotsExecuted.push("pre");
        await next();
      },
    });
    commandLayer.use({
      name: "test_tenant",
      slot: "tenant",
      handler: async (_ctx, next) => {
        slotsExecuted.push("tenant");
        await next();
      },
    });
    commandLayer.use({
      name: "test_pre_action",
      slot: "pre-action",
      handler: async (_ctx, next) => {
        slotsExecuted.push("pre-action");
        await next();
      },
    });
    commandLayer.use({
      name: "test_post_action",
      slot: "post-action",
      handler: async (_ctx, next) => {
        slotsExecuted.push("post-action");
        await next();
      },
    });

    const engine = createApprovalEngine({ store, eventBus, commandLayer });

    const createResult = await engine.createRequest({
      action: "submit_request",
      schema: "purchase_request",
      input: { title: "Laptop", amount: 15000 },
      actor: defaultActor,
      executionId: "exec-cl-2",
      effect: { type: "require_approval", level: "manager" },
      triggerRules: ["amount_check"],
    });

    await engine.approve({ approvalId: createResult.approvalId }, managerActor);

    expect(slotsExecuted).toContain("pre");
    expect(slotsExecuted).toContain("tenant");
    expect(slotsExecuted).toContain("pre-action");
    expect(slotsExecuted).toContain("post-action");
  });

  it("auth/exposure/permission slots are SKIPPED on re-execution", async () => {
    const slotsExecuted: string[] = [];

    commandLayer.use({
      name: "test_auth",
      slot: "auth",
      handler: async (_ctx, next) => {
        slotsExecuted.push("auth");
        await next();
      },
    });
    commandLayer.use({
      name: "test_permission",
      slot: "permission",
      handler: async (_ctx, next) => {
        slotsExecuted.push("permission");
        await next();
      },
    });
    commandLayer.use({
      name: "test_pre",
      slot: "pre",
      handler: async (_ctx, next) => {
        slotsExecuted.push("pre");
        await next();
      },
    });

    const engine = createApprovalEngine({ store, eventBus, commandLayer });

    const createResult = await engine.createRequest({
      action: "submit_request",
      schema: "purchase_request",
      input: { title: "Laptop", amount: 15000 },
      actor: defaultActor,
      executionId: "exec-cl-3",
      effect: { type: "require_approval", level: "manager" },
      triggerRules: ["amount_check"],
    });

    await engine.approve({ approvalId: createResult.approvalId }, managerActor);

    // Auth and permission should NOT have been called
    expect(slotsExecuted).not.toContain("auth");
    expect(slotsExecuted).not.toContain("permission");
    // Pre should have been called
    expect(slotsExecuted).toContain("pre");
  });

  it("falls back to direct executor when commandLayer is not provided", async () => {
    // No commandLayer, only executor — backward compatibility
    const engine = createApprovalEngine({ store, eventBus, executor });

    const createResult = await engine.createRequest({
      action: "submit_request",
      schema: "purchase_request",
      input: { title: "Laptop", amount: 15000 },
      actor: defaultActor,
      executionId: "exec-cl-4",
      effect: { type: "require_approval", level: "manager" },
      triggerRules: ["amount_check"],
    });

    const result = await engine.approve({ approvalId: createResult.approvalId }, managerActor);
    expect(result.success).toBe(true);
  });
});

describe("ApprovalEngine — deferred executor wiring", () => {
  it("setExecutor allows late binding of the action executor", async () => {
    const store = new InMemoryApprovalStore();
    const { bus } = createEventBus();

    // Create engine without executor
    const engine = createApprovalEngine({ store, eventBus: bus });

    // Create a request
    const pendingResult = await engine.createRequest({
      action: "submit_request",
      schema: "purchase_request",
      input: { title: "Laptop", amount: 15000 },
      actor: defaultActor,
      executionId: "exec-deferred",
      effect: { type: "require_approval", level: "manager" },
      triggerRules: ["amount_check"],
    });

    // Try to approve without executor — should throw
    await expect(
      engine.approve({ approvalId: pendingResult.approvalId }, managerActor),
    ).rejects.toThrow("executor not configured");

    // Status should still be "pending" since executor check happens before status update
    const stored = store.getById(pendingResult.approvalId);
    expect(stored?.status).toBe("pending");

    // Now wire up the executor
    const dataProvider = createMemoryDataProvider();
    const executor = createActionExecutor({ dataProvider });
    executor.registry.register(submitRequestAction);
    engine.setExecutor(executor);

    // Approve the same request should now succeed
    const successResult = await engine.approve(
      { approvalId: pendingResult.approvalId },
      managerActor,
    );
    expect(successResult.success).toBe(true);
  });
});
