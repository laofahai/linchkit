/**
 * End-to-end integration test: Full LinchKit runtime flow.
 *
 * Covers the complete lifecycle:
 *   Schema registration → CRUD via CommandLayer → State transitions →
 *   Rule evaluation (block + warn + require_approval) → Approval flow →
 *   Flow execution (SyncFlowEngine) → Event chain verification →
 *   Optimistic locking (conflict detection)
 *
 * All in-memory — no external services required.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import type {
  ActionDefinition,
  Actor,
  FlowDefinition,
  RuleDefinition,
  EntityDefinition,
  StateDefinition,
} from "@linchkit/core";
import {
  type ActionExecutor,
  type CommandLayer,
  canTransition as canTransitionFn,
  createActionExecutor,
  createApprovalEngine,
  createApprovalVerifier,
  createCommandLayer,
  createEventBus,
  createEntityRegistry,
  createStateMachine,
  createSyncFlowEngine,
  type DataProvider,
  evaluateRules,
  InMemoryApprovalStore,
  InMemoryExecutionLogger,
} from "@linchkit/core/server";

// ── Schema ───────────────────────────────────────────────

const expenseSchema: EntityDefinition = {
  name: "expense_report",
  label: "Expense Report",
  fields: {
    title: { type: "string", required: true, label: "Title", default: "" },
    amount: { type: "number", required: true, label: "Amount", default: 0 },
    department: { type: "string", label: "Department" },
    requester: { type: "string", label: "Requester" },
    notes: { type: "text", label: "Notes" },
    status: { type: "state", machine: "expense_lifecycle", default: "draft" },
    priority: {
      type: "enum",
      options: [
        { value: "low", label: "Low" },
        { value: "normal", label: "Normal" },
        { value: "high", label: "High" },
        { value: "urgent", label: "Urgent" },
      ],
      label: "Priority",
    },
  },
};

// ── State Machine ─────────────────────────────────────────

const expenseStateDef: StateDefinition = {
  name: "expense_lifecycle",
  entity: "expense_report",
  states: ["draft", "submitted", "approved", "rejected", "cancelled"],
  initial: "draft",
  transitions: [
    { from: "draft", to: "submitted", action: "submit_expense" },
    { from: "submitted", to: "approved", action: "approve_expense" },
    { from: "submitted", to: "rejected", action: "reject_expense" },
    { from: ["draft", "submitted"], to: "cancelled", action: "cancel_expense" },
  ],
};

// ── Actors ────────────────────────────────────────────────

const employeeActor: Actor = {
  type: "human",
  id: "emp-001",
  name: "Alice Employee",
  groups: ["employee"],
};

const managerActor: Actor = {
  type: "human",
  id: "mgr-001",
  name: "Bob Manager",
  groups: ["manager", "employee"],
};

const _adminActor: Actor = {
  type: "human",
  id: "admin-001",
  name: "Carol Admin",
  groups: ["admin"],
};

// ── In-memory DataProvider with _version support ──────────

function createVersionedDataProvider(): DataProvider {
  const store = new Map<string, Map<string, Record<string, unknown>>>();
  let counter = 0;

  function getTable(schema: string): Map<string, Record<string, unknown>> {
    if (!store.has(schema)) store.set(schema, new Map());
    // biome-ignore lint/style/noNonNullAssertion: guaranteed to exist after set above
    return store.get(schema)!;
  }

  return {
    async get(schema, id) {
      const record = getTable(schema).get(id);
      if (!record) throw new Error(`Record not found: ${schema}/${id}`);
      return { ...record };
    },
    async query(schema, _filter) {
      return Array.from(getTable(schema).values()).map((r) => ({ ...r }));
    },
    async create(schema, data) {
      counter++;
      const id = (data.id as string) ?? `rec_${counter}`;
      const record: Record<string, unknown> = {
        ...data,
        id,
        _version: 1,
        tenant_id: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        created_by: null,
        updated_by: null,
      };
      getTable(schema).set(id, record);
      return { ...record };
    },
    async update(schema, id, updates) {
      const table = getTable(schema);
      const existing = table.get(id);
      if (!existing) throw new Error(`Record not found: ${schema}/${id}`);

      // Optimistic locking: if caller sends _version, check it matches
      if (
        updates._version !== undefined &&
        existing._version !== undefined &&
        updates._version !== existing._version
      ) {
        const err = new Error(
          `Version conflict on ${schema}/${id}: expected ${updates._version}, got ${existing._version}`,
        );
        (err as Error & { code: string }).code = "CONFLICT";
        throw err;
      }

      const updated = {
        ...existing,
        ...updates,
        _version: ((existing._version as number) ?? 0) + 1,
        updated_at: new Date().toISOString(),
      };
      table.set(id, updated);
      return { ...updated };
    },
    async delete(schema, id) {
      const table = getTable(schema);
      if (!table.has(id)) throw new Error(`Record not found: ${schema}/${id}`);
      table.delete(id);
    },
    async count(schema, _filter?) {
      return getTable(schema).size;
    },
  };
}

// ── Collected events (for event chain verification) ──────

const collectedEvents: Array<{ type: string; payload: Record<string, unknown> }> = [];

// ── Test runtime setup ───────────────────────────────────

let dataProvider: DataProvider;
let executor: ActionExecutor;
let layer: CommandLayer;

const entityRegistry = createEntityRegistry();
const executionLogger = new InMemoryExecutionLogger();
const stateMachine = createStateMachine(expenseStateDef);
const approvalStore = new InMemoryApprovalStore();
const approvalEngine = createApprovalEngine({ store: approvalStore });
const verifyApproval = createApprovalVerifier(approvalStore);
const { bus: _eventBus, registry: eventRegistry } = createEventBus();

// ── Actions ──────────────────────────────────────────────

const createExpenseAction: ActionDefinition = {
  name: "create_expense",
  entity: "expense_report",
  label: "Create Expense Report",
  policy: { mode: "sync", transaction: false },
  exposure: "all",
  handler: async (ctx) => {
    const record = await ctx.create("expense_report", {
      ...ctx.input,
      status: ctx.input.status ?? "draft",
    });
    ctx.emit("expense.created", {
      entity: "expense_report",
      recordId: record.id,
    });
    return record;
  },
};

const readExpenseAction: ActionDefinition = {
  name: "read_expense",
  entity: "expense_report",
  label: "Read Expense Report",
  policy: { mode: "sync", transaction: false },
  exposure: "all",
  handler: async (ctx) => {
    return ctx.get("expense_report", ctx.input.id as string);
  },
};

const updateExpenseAction: ActionDefinition = {
  name: "update_expense",
  entity: "expense_report",
  label: "Update Expense Report",
  policy: { mode: "sync", transaction: false },
  exposure: "all",
  handler: async (ctx) => {
    const { id, ...updates } = ctx.input;
    const record = await ctx.update("expense_report", id as string, updates);
    ctx.emit("expense.updated", {
      entity: "expense_report",
      recordId: id,
    });
    return record;
  },
};

const deleteExpenseAction: ActionDefinition = {
  name: "delete_expense",
  entity: "expense_report",
  label: "Delete Expense Report",
  policy: { mode: "sync", transaction: false },
  exposure: "all",
  handler: async (ctx) => {
    await ctx.delete("expense_report", ctx.input.id as string);
    ctx.emit("expense.deleted", {
      entity: "expense_report",
      recordId: ctx.input.id,
    });
    return { deleted: true, id: ctx.input.id };
  },
};

const submitExpenseAction: ActionDefinition = {
  name: "submit_expense",
  entity: "expense_report",
  label: "Submit Expense Report",
  stateTransition: { from: "draft", to: "submitted" },
  policy: { mode: "sync", transaction: false },
  exposure: "all",
  handler: async (ctx) => {
    const id = ctx.input.id as string;
    const record = await ctx.get("expense_report", id);
    if (record.status !== "draft") {
      throw new Error(`Cannot submit: current status is "${record.status}", expected "draft"`);
    }
    const updated = await ctx.update("expense_report", id, {
      status: "submitted",
      _version: record._version,
    });
    ctx.emit("expense.submitted", {
      entity: "expense_report",
      recordId: id,
      previousStatus: "draft",
      newStatus: "submitted",
    });
    return updated;
  },
};

const approveExpenseAction: ActionDefinition = {
  name: "approve_expense",
  entity: "expense_report",
  label: "Approve Expense Report",
  permissions: { groups: ["manager", "admin"] },
  stateTransition: { from: "submitted", to: "approved" },
  policy: { mode: "sync", transaction: false },
  exposure: "all",
  handler: async (ctx) => {
    const id = ctx.input.id as string;
    const record = await ctx.get("expense_report", id);
    if (record.status !== "submitted") {
      throw new Error(`Cannot approve: current status is "${record.status}", expected "submitted"`);
    }
    const updated = await ctx.update("expense_report", id, {
      status: "approved",
      _version: record._version,
    });
    ctx.emit("expense.approved", {
      entity: "expense_report",
      recordId: id,
      previousStatus: "submitted",
      newStatus: "approved",
    });
    return updated;
  },
};

const rejectExpenseAction: ActionDefinition = {
  name: "reject_expense",
  entity: "expense_report",
  label: "Reject Expense Report",
  permissions: { groups: ["manager", "admin"] },
  stateTransition: { from: "submitted", to: "rejected" },
  policy: { mode: "sync", transaction: false },
  exposure: "all",
  handler: async (ctx) => {
    const id = ctx.input.id as string;
    const record = await ctx.get("expense_report", id);
    if (record.status !== "submitted") {
      throw new Error(`Cannot reject: current status is "${record.status}", expected "submitted"`);
    }
    const updated = await ctx.update("expense_report", id, {
      status: "rejected",
      _version: record._version,
    });
    ctx.emit("expense.rejected", {
      entity: "expense_report",
      recordId: id,
    });
    return updated;
  },
};

// ── Rules ────────────────────────────────────────────────

const blockExcessiveAmountRule: RuleDefinition = {
  name: "block_excessive_amount",
  label: "Block Excessive Amount",
  trigger: { action: "submit_expense" },
  condition: { field: "target.amount", operator: "gt", value: 100_000 },
  effect: {
    type: "block",
    message: "Amount exceeds maximum limit of 100,000",
    reason: "amount_exceeds_limit",
  },
  priority: 20,
};

const warnLargeAmountRule: RuleDefinition = {
  name: "warn_large_amount",
  label: "Warn Large Amount",
  trigger: { action: "submit_expense" },
  condition: { field: "target.amount", operator: "gt", value: 5_000 },
  effect: { type: "warn", message: "This is a large expense, please double-check" },
  priority: 10,
};

const requireManagerApprovalRule: RuleDefinition = {
  name: "require_manager_approval",
  label: "Require Manager Approval",
  trigger: { action: "submit_expense" },
  condition: { field: "target.amount", operator: "gt", value: 10_000 },
  effect: {
    type: "require_approval",
    level: "manager",
    message: "Manager approval required for expenses over 10,000",
  },
  priority: 15,
};

const allRules = [blockExcessiveAmountRule, warnLargeAmountRule, requireManagerApprovalRule];

const allActions = [
  createExpenseAction,
  readExpenseAction,
  updateExpenseAction,
  deleteExpenseAction,
  submitExpenseAction,
  approveExpenseAction,
  rejectExpenseAction,
];

// ── Setup ────────────────────────────────────────────────

beforeAll(() => {
  dataProvider = createVersionedDataProvider();
  executor = createActionExecutor({
    dataProvider,
    stateMachine,
    executionLogger,
  });

  for (const action of allActions) {
    executor.registry.register(action);
  }

  // Wire executor into approval engine for re-execution on approve
  approvalEngine.setExecutor(executor);

  entityRegistry.register(expenseSchema);

  layer = createCommandLayer({
    executor,
    verifyApproval: async (approvalId: string) => {
      return verifyApproval(approvalId);
    },
  });

  // Register event handler to collect all events
  eventRegistry.register({
    name: "event_collector",
    listen: [
      "expense.created",
      "expense.updated",
      "expense.deleted",
      "expense.submitted",
      "expense.approved",
      "expense.rejected",
    ],
    handler: async (event) => {
      collectedEvents.push({ type: event.type, payload: event.payload });
    },
  });
});

// ── Tests ────────────────────────────────────────────────

describe("E2E: Full LinchKit Runtime Flow", () => {
  let createdId: string;
  let createdVersion: number;

  // ── 1. CRUD via CommandLayer ───────────────────────────

  describe("1. CRUD via CommandLayer", () => {
    test("1a. Create — returns record with all system fields", async () => {
      const result = await layer.execute({
        command: "create_expense",
        input: {
          title: "E2E Office Supplies",
          amount: 250,
          department: "Engineering",
          requester: "emp-001",
          priority: "normal",
        },
        actor: employeeActor,
      });

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.id).toBeDefined();
      expect(data.title).toBe("E2E Office Supplies");
      expect(data.amount).toBe(250);
      expect(data.status).toBe("draft");
      expect(data._version).toBe(1);
      expect(data.tenant_id).toBeNull();
      expect(data.created_at).toBeDefined();
      expect(data.updated_at).toBeDefined();

      createdId = data.id as string;
      createdVersion = data._version as number;
    });

    test("1b. Read — retrieves the created record", async () => {
      const result = await layer.execute({
        command: "read_expense",
        input: { id: createdId },
        actor: employeeActor,
      });

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.id).toBe(createdId);
      expect(data.title).toBe("E2E Office Supplies");
      expect(data.amount).toBe(250);
    });

    test("1c. Update — modifies fields and increments version", async () => {
      const result = await layer.execute({
        command: "update_expense",
        input: {
          id: createdId,
          title: "E2E Updated Office Supplies",
          amount: 350,
          _version: createdVersion,
        },
        actor: employeeActor,
      });

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.title).toBe("E2E Updated Office Supplies");
      expect(data.amount).toBe(350);
      expect(data._version).toBe(2);
      createdVersion = data._version as number;
    });

    test("1d. Delete — removes the record", async () => {
      // Create a separate record to delete
      const createResult = await layer.execute({
        command: "create_expense",
        input: { title: "To Delete", amount: 10 },
        actor: employeeActor,
      });
      const deleteId = (createResult.data as Record<string, unknown>).id as string;

      const deleteResult = await layer.execute({
        command: "delete_expense",
        input: { id: deleteId },
        actor: employeeActor,
      });

      expect(deleteResult.success).toBe(true);
      const data = deleteResult.data as Record<string, unknown>;
      expect(data.deleted).toBe(true);

      // Verify it's gone
      const readResult = await layer.execute({
        command: "read_expense",
        input: { id: deleteId },
        actor: employeeActor,
      });
      expect(readResult.success).toBe(false);
    });
  });

  // ── 2. State transitions ──────────────────────────────

  describe("2. State transitions", () => {
    test("2a. Submit transitions draft → submitted", async () => {
      const result = await layer.execute({
        command: "submit_expense",
        input: { id: createdId },
        actor: employeeActor,
      });

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.status).toBe("submitted");
    });

    test("2b. Cannot submit again (already submitted)", async () => {
      const result = await layer.execute({
        command: "submit_expense",
        input: { id: createdId },
        actor: employeeActor,
      });

      expect(result.success).toBe(false);
    });

    test("2c. Approve transitions submitted → approved (manager only)", async () => {
      const result = await layer.execute({
        command: "approve_expense",
        input: { id: createdId },
        actor: managerActor,
      });

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.status).toBe("approved");
    });

    test("2d. Employee cannot approve (permission denied)", async () => {
      // Create and submit a new expense
      const createResult = await layer.execute({
        command: "create_expense",
        input: { title: "Permission Test", amount: 100 },
        actor: employeeActor,
      });
      const id = (createResult.data as Record<string, unknown>).id as string;

      await layer.execute({
        command: "submit_expense",
        input: { id },
        actor: employeeActor,
      });

      // Employee tries to approve — should be denied
      const approveResult = await layer.execute({
        command: "approve_expense",
        input: { id },
        actor: employeeActor,
      });

      expect(approveResult.success).toBe(false);
      const data = approveResult.data as Record<string, unknown>;
      expect((data.error as string) || "").toContain("groups");
    });

    test("2e. Reject transitions submitted → rejected", async () => {
      // Create and submit
      const createResult = await layer.execute({
        command: "create_expense",
        input: { title: "Reject Test", amount: 200 },
        actor: employeeActor,
      });
      const id = (createResult.data as Record<string, unknown>).id as string;

      await layer.execute({
        command: "submit_expense",
        input: { id },
        actor: employeeActor,
      });

      const rejectResult = await layer.execute({
        command: "reject_expense",
        input: { id },
        actor: managerActor,
      });

      expect(rejectResult.success).toBe(true);
      const data = rejectResult.data as Record<string, unknown>;
      expect(data.status).toBe("rejected");
    });
  });

  // ── 3. Rule evaluation ────────────────────────────────

  describe("3. Rule evaluation", () => {
    test("3a. Block rule — amount over 100,000 is blocked", async () => {
      const ruleInput = {
        target: { amount: 150_000, status: "draft" },
        actor: employeeActor,
        context: {},
      };

      const result = await evaluateRules(allRules, ruleInput);

      expect(result.blocked).toBe(true);
      expect(result.blockReasons).toContain("amount_exceeds_limit");
    });

    test("3b. Warn rule — amount over 5,000 triggers warning", async () => {
      const ruleInput = {
        target: { amount: 8_000, status: "draft" },
        actor: employeeActor,
        context: {},
      };

      const result = await evaluateRules(allRules, ruleInput);

      expect(result.blocked).toBe(false);
      expect(result.warnings.length).toBeGreaterThanOrEqual(1);
      expect(result.warnings.some((w) => w.message.includes("large expense"))).toBe(true);
    });

    test("3c. Require approval rule — amount over 10,000 requires manager approval", async () => {
      const ruleInput = {
        target: { amount: 15_000, status: "draft" },
        actor: employeeActor,
        context: {},
      };

      const result = await evaluateRules(allRules, ruleInput);

      expect(result.blocked).toBe(false);
      expect(result.requiredApproval).not.toBeNull();
      expect(result.requiredApproval?.level).toBe("manager");
    });

    test("3d. Small amount — no rules triggered", async () => {
      const ruleInput = {
        target: { amount: 100, status: "draft" },
        actor: employeeActor,
        context: {},
      };

      const result = await evaluateRules(allRules, ruleInput);

      expect(result.blocked).toBe(false);
      expect(result.warnings).toHaveLength(0);
      expect(result.requiredApproval).toBeNull();
    });

    test("3e. Mixed effects — warn + require_approval at 15,000", async () => {
      const ruleInput = {
        target: { amount: 15_000, status: "draft" },
        actor: employeeActor,
        context: {},
      };

      const result = await evaluateRules(allRules, ruleInput);

      // Both warn (>5000) and require_approval (>10000) should trigger
      expect(result.warnings.length).toBeGreaterThanOrEqual(1);
      expect(result.requiredApproval).not.toBeNull();
      expect(result.requiredApproval?.level).toBe("manager");
    });
  });

  // ── 4. Approval flow ──────────────────────────────────

  describe("4. Approval flow", () => {
    test("4a. Create approval request, approve, verify", async () => {
      // Create an approval request using the correct CreateApprovalOptions shape
      const request = await approvalEngine.createRequest({
        action: "submit_expense",
        entity: "expense_report",
        input: { id: "exp-high-value", amount: 20_000 },
        actor: employeeActor,
        executionId: `exec_${crypto.randomUUID()}`,
        effect: {
          type: "require_approval",
          level: "manager",
          message: "Manager approval required for expenses over 10,000",
        },
        triggerRules: ["require_manager_approval"],
      });

      expect(request.approvalId).toBeDefined();
      expect(request.status).toBe("pending_approval");

      // Manager approves
      await approvalEngine.approve(
        { approvalId: request.approvalId, note: "Looks good" },
        managerActor,
      );
      // Check the approval store directly
      const stored = await approvalStore.getById(request.approvalId);
      expect(stored?.status).toBe("approved");

      // Verify the approval via the verifier
      const isValid = await verifyApproval(request.approvalId);
      expect(isValid).toBe(true);
    });

    test("4b. Rejected approval is not valid for re-execution", async () => {
      const request = await approvalEngine.createRequest({
        action: "submit_expense",
        entity: "expense_report",
        input: { id: "exp-rejected-val", amount: 50_000 },
        actor: employeeActor,
        executionId: `exec_${crypto.randomUUID()}`,
        effect: {
          type: "require_approval",
          level: "manager",
          message: "Manager approval required",
        },
        triggerRules: ["require_manager_approval"],
      });

      // Manager rejects
      await approvalEngine.reject(
        { approvalId: request.approvalId, note: "Too expensive" },
        managerActor,
      );

      // Should not be valid
      const isValid = await verifyApproval(request.approvalId);
      expect(isValid).toBe(false);
    });

    test("4c. CommandLayer with approved approvalId skips security slots", async () => {
      // Create and get an approved request
      const request = await approvalEngine.createRequest({
        action: "create_expense",
        entity: "expense_report",
        input: { title: "Approved via Pipeline", amount: 25_000 },
        actor: employeeActor,
        executionId: `exec_${crypto.randomUUID()}`,
        effect: {
          type: "require_approval",
          level: "manager",
          message: "Manager approval required",
        },
        triggerRules: ["require_manager_approval"],
      });
      await approvalEngine.approve(
        { approvalId: request.approvalId, note: "Approved" },
        managerActor,
      );

      // Execute with approvalId — should succeed
      const result = await layer.execute({
        command: "create_expense",
        input: { title: "Approved via Pipeline", amount: 25_000 },
        actor: employeeActor,
        approvalId: request.approvalId,
      });

      expect(result.success).toBe(true);
    });

    test("4d. CommandLayer rejects invalid approvalId", async () => {
      const result = await layer.execute({
        command: "create_expense",
        input: { title: "Invalid Approval", amount: 25_000 },
        actor: employeeActor,
        approvalId: "nonexistent_approval_id",
      });

      expect(result.success).toBe(false);
      const data = result.data as Record<string, unknown>;
      expect(data.error).toContain("Invalid");
    });
  });

  // ── 5. Flow execution (SyncFlowEngine) ────────────────

  describe("5. Flow execution", () => {
    test("5a. Linear flow: action → action → complete", async () => {
      const executedSteps: string[] = [];

      const ctx = {
        flowContext: {},
        async executeAction(actionName: string, input: Record<string, unknown>) {
          executedSteps.push(actionName);
          return { success: true, actionName, ...input };
        },
        async callAI() {
          return { response: "mock", tokensUsed: 0 };
        },
        evaluateCondition(expr: string) {
          return expr === "true";
        },
      };

      const flow: FlowDefinition = {
        name: "expense-processing-flow",
        trigger: { type: "manual" },
        steps: [
          {
            id: "validate",
            name: "Validate Expense",
            type: "action",
            actionName: "validate_expense",
            input: { check: "format" },
          },
          {
            id: "notify",
            name: "Notify Manager",
            type: "action",
            actionName: "send_notification",
            input: { to: "manager" },
          },
        ],
      };

      const engine = createSyncFlowEngine(ctx);
      engine.registerFlow(flow);

      const instance = await engine.startFlow("expense-processing-flow", {
        expenseId: "exp-001",
      });

      expect(instance.status).toBe("completed");
      expect(instance.flowName).toBe("expense-processing-flow");
      expect(executedSteps).toEqual(["validate_expense", "send_notification"]);
    });

    test("5b. Condition flow: action → condition → branch", async () => {
      const executedSteps: string[] = [];

      const ctx = {
        flowContext: {},
        async executeAction(actionName: string, _input: Record<string, unknown>) {
          executedSteps.push(actionName);
          return { success: true };
        },
        async callAI() {
          return { response: "mock", tokensUsed: 0 };
        },
        evaluateCondition(expr: string) {
          // Simulate: amount > 10000 → true
          return expr === "true";
        },
      };

      const flow: FlowDefinition = {
        name: "conditional-expense-flow",
        trigger: { type: "manual" },
        steps: [
          {
            id: "create",
            name: "Create Expense",
            type: "action",
            actionName: "create_expense",
          },
          {
            id: "check_amount",
            name: "Check Amount",
            type: "condition",
            expression: "true",
            // biome-ignore lint/suspicious/noThenProperty: flow condition step definition
            then: "auto_approve",
            else: "manual_review",
          },
          {
            id: "auto_approve",
            name: "Auto Approve",
            type: "action",
            actionName: "auto_approve",
          },
          {
            id: "manual_review",
            name: "Manual Review",
            type: "action",
            actionName: "manual_review",
          },
        ],
      };

      const engine = createSyncFlowEngine(ctx);
      engine.registerFlow(flow);

      const instance = await engine.startFlow("conditional-expense-flow", {});

      expect(instance.status).toBe("completed");
      expect(executedSteps).toContain("create_expense");
      expect(executedSteps).toContain("auto_approve");
    });

    test("5c. Flow failure propagates error info", async () => {
      const ctx = {
        flowContext: {},
        async executeAction(actionName: string, _input: Record<string, unknown>) {
          if (actionName === "failing_step") {
            throw new Error("External service unavailable");
          }
          return { success: true };
        },
        async callAI() {
          return { response: "mock", tokensUsed: 0 };
        },
        evaluateCondition(expr: string) {
          return expr === "true";
        },
      };

      const flow: FlowDefinition = {
        name: "failing-flow",
        trigger: { type: "manual" },
        steps: [
          {
            id: "step1",
            name: "Succeed",
            type: "action",
            actionName: "ok_step",
          },
          {
            id: "step2",
            name: "Fail",
            type: "action",
            actionName: "failing_step",
          },
        ],
      };

      const engine = createSyncFlowEngine(ctx);
      engine.registerFlow(flow);

      const instance = await engine.startFlow("failing-flow", {});

      expect(instance.status).toBe("failed");
      expect(instance.error).toBeDefined();
      expect(instance.error?.message).toContain("External service unavailable");
      expect(instance.error?.stepId).toBe("step2");
    });

    test("5d. Flow status tracking by instance ID", async () => {
      const ctx = {
        flowContext: {},
        async executeAction() {
          return { success: true };
        },
        async callAI() {
          return { response: "mock", tokensUsed: 0 };
        },
        evaluateCondition() {
          return true;
        },
      };

      const flow: FlowDefinition = {
        name: "trackable-flow",
        trigger: { type: "manual" },
        steps: [
          {
            id: "only",
            name: "Only Step",
            type: "action",
            actionName: "noop",
          },
        ],
      };

      const engine = createSyncFlowEngine(ctx);
      engine.registerFlow(flow);

      const _instance = await engine.startFlow(
        "trackable-flow",
        {},
        {
          instanceId: "track-123",
        },
      );

      const status = await engine.getFlowStatus("track-123");
      expect(status).not.toBeNull();
      expect(status?.id).toBe("track-123");
      expect(status?.status).toBe("completed");
    });
  });

  // ── 6. Event chain verification ───────────────────────

  describe("6. Event chain verification", () => {
    test("6a. EventBus delivers events to matching handlers", async () => {
      const received: string[] = [];

      const { bus, registry } = createEventBus();
      registry.register({
        name: "chain_listener",
        listen: ["expense.created", "expense.submitted"],
        handler: async (event) => {
          received.push(event.type);
        },
      });

      await bus.emit({
        id: crypto.randomUUID(),
        type: "expense.created",
        category: "runtime",
        timestamp: new Date(),
        actor: { type: "human", id: "emp-001" },
        executionId: crypto.randomUUID(),
        payload: { schema: "expense_report", recordId: "r1" },
      });

      await bus.emit({
        id: crypto.randomUUID(),
        type: "expense.submitted",
        category: "runtime",
        timestamp: new Date(),
        actor: { type: "human", id: "emp-001" },
        executionId: crypto.randomUUID(),
        payload: { schema: "expense_report", recordId: "r1" },
      });

      await bus.emit({
        id: crypto.randomUUID(),
        type: "expense.approved",
        category: "runtime",
        timestamp: new Date(),
        actor: { type: "human", id: "mgr-001" },
        executionId: crypto.randomUUID(),
        payload: { schema: "expense_report", recordId: "r1" },
      });

      expect(received).toEqual(["expense.created", "expense.submitted"]);
      // approved should NOT be received (not in listen list)
    });

    test("6b. Event handlers execute in priority order", async () => {
      const order: string[] = [];
      const { bus, registry } = createEventBus();

      registry.register({
        name: "low_prio",
        listen: "test.ordered",
        priority: 200,
        handler: async () => {
          order.push("low");
        },
      });
      registry.register({
        name: "high_prio",
        listen: "test.ordered",
        priority: 10,
        handler: async () => {
          order.push("high");
        },
      });
      registry.register({
        name: "default_prio",
        listen: "test.ordered",
        handler: async () => {
          order.push("default");
        },
      });

      await bus.emit({
        id: crypto.randomUUID(),
        type: "test.ordered",
        category: "runtime",
        timestamp: new Date(),
        actor: { type: "system", id: "test" },
        executionId: crypto.randomUUID(),
        payload: {},
      });

      expect(order).toEqual(["high", "default", "low"]);
    });

    test("6c. Event filter matching works correctly", async () => {
      const received: string[] = [];
      const { bus, registry } = createEventBus();

      registry.register({
        name: "filtered_handler",
        listen: "record.created",
        filter: { schema: "expense_report" },
        handler: async () => {
          received.push("expense_only");
        },
      });
      registry.register({
        name: "unfiltered_handler",
        listen: "record.created",
        handler: async () => {
          received.push("any");
        },
      });

      // Matching filter
      await bus.emit({
        id: crypto.randomUUID(),
        type: "record.created",
        category: "runtime",
        timestamp: new Date(),
        actor: { type: "system", id: "test" },
        executionId: crypto.randomUUID(),
        payload: { schema: "expense_report" },
      });

      expect(received).toEqual(["expense_only", "any"]);
      received.length = 0;

      // Non-matching filter
      await bus.emit({
        id: crypto.randomUUID(),
        type: "record.created",
        category: "runtime",
        timestamp: new Date(),
        actor: { type: "system", id: "test" },
        executionId: crypto.randomUUID(),
        payload: { schema: "purchase_order" },
      });

      expect(received).toEqual(["any"]);
    });

    test("6d. Event log tracks emitted events", async () => {
      const { bus } = createEventBus();

      await bus.emit({
        id: crypto.randomUUID(),
        type: "log.test1",
        category: "runtime",
        timestamp: new Date(),
        actor: { type: "system", id: "test" },
        executionId: crypto.randomUUID(),
        payload: {},
      });
      await bus.emit({
        id: crypto.randomUUID(),
        type: "log.test2",
        category: "runtime",
        timestamp: new Date(),
        actor: { type: "system", id: "test" },
        executionId: crypto.randomUUID(),
        payload: {},
      });

      const log = bus.getEmittedEvents();
      expect(log).toHaveLength(2);
      expect(log[0].type).toBe("log.test1");
      expect(log[1].type).toBe("log.test2");
    });
  });

  // ── 7. Optimistic locking ─────────────────────────────

  describe("7. Optimistic locking (conflict detection)", () => {
    test("7a. Concurrent updates with stale version fail", async () => {
      // Create a fresh record
      const createResult = await layer.execute({
        command: "create_expense",
        input: { title: "Conflict Test", amount: 500 },
        actor: employeeActor,
      });
      const data = createResult.data as Record<string, unknown>;
      const conflictId = data.id as string;
      const v1 = data._version as number;

      // First update succeeds (version 1 → 2)
      const update1 = await layer.execute({
        command: "update_expense",
        input: { id: conflictId, title: "Update A", _version: v1 },
        actor: employeeActor,
      });
      expect(update1.success).toBe(true);
      expect((update1.data as Record<string, unknown>)._version).toBe(2);

      // Second update with stale version (still v1) should fail
      const update2 = await layer.execute({
        command: "update_expense",
        input: { id: conflictId, title: "Update B", _version: v1 },
        actor: employeeActor,
      });

      expect(update2.success).toBe(false);
    });

    test("7b. Sequential updates with correct version succeed", async () => {
      const createResult = await layer.execute({
        command: "create_expense",
        input: { title: "Sequential Test", amount: 100 },
        actor: employeeActor,
      });
      const data1 = createResult.data as Record<string, unknown>;
      const seqId = data1.id as string;

      // Update 1: v1 → v2
      const update1 = await layer.execute({
        command: "update_expense",
        input: { id: seqId, title: "Step 1", _version: data1._version },
        actor: employeeActor,
      });
      expect(update1.success).toBe(true);
      const data2 = update1.data as Record<string, unknown>;

      // Update 2: v2 → v3
      const update2 = await layer.execute({
        command: "update_expense",
        input: { id: seqId, title: "Step 2", _version: data2._version },
        actor: employeeActor,
      });
      expect(update2.success).toBe(true);
      expect((update2.data as Record<string, unknown>)._version).toBe(3);
    });
  });

  // ── 8. Execution logging ──────────────────────────────

  describe("8. Execution logging", () => {
    test("8a. Successful actions are logged", () => {
      const allLogs = executionLogger.getAll();
      const succeeded = allLogs.filter((l) => l.status === "succeeded");
      expect(succeeded.length).toBeGreaterThan(0);
    });

    test("8b. Failed actions are logged", () => {
      const allLogs = executionLogger.getAll();
      const failed = allLogs.filter((l) => l.status === "failed");
      expect(failed.length).toBeGreaterThan(0);
    });

    test("8c. Each execution has a unique ID", () => {
      const allLogs = executionLogger.getAll();
      const ids = new Set(allLogs.map((l) => l.id));
      expect(ids.size).toBe(allLogs.length);
    });
  });

  // ── 9. Schema Registry ────────────────────────────────

  describe("9. Schema Registry", () => {
    test("9a. Schema is registered and retrievable", () => {
      const schema = entityRegistry.get("expense_report");
      expect(schema).toBeDefined();
      expect(schema?.name).toBe("expense_report");
      expect(schema?.fields.title).toBeDefined();
      expect(schema?.fields.status.type).toBe("state");
    });

    test("9b. Has check works", () => {
      expect(entityRegistry.has("expense_report")).toBe(true);
      expect(entityRegistry.has("nonexistent")).toBe(false);
    });

    test("9c. All schemas are listed", () => {
      const all = entityRegistry.getAll();
      expect(all.length).toBeGreaterThanOrEqual(1);
      expect(all.some((s) => s.name === "expense_report")).toBe(true);
    });
  });

  // ── 10. State machine validation ──────────────────────

  describe("10. State machine integration", () => {
    test("10a. Valid transitions are accepted", () => {
      expect(canTransitionFn(stateMachine, "draft", "submit_expense")).toBe(true);
      expect(canTransitionFn(stateMachine, "submitted", "approve_expense")).toBe(true);
      expect(canTransitionFn(stateMachine, "submitted", "reject_expense")).toBe(true);
    });

    test("10b. Invalid transitions are rejected", () => {
      expect(canTransitionFn(stateMachine, "draft", "approve_expense")).toBe(false);
      expect(canTransitionFn(stateMachine, "approved", "submit_expense")).toBe(false);
      expect(canTransitionFn(stateMachine, "rejected", "approve_expense")).toBe(false);
    });
  });
});
