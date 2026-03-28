import { describe, expect, test } from "bun:test";
import { createActionExecutor, type DataProvider } from "../src/engine/action-engine";
import { createStateMachine } from "../src/engine/state-machine";
import type { ActionDefinition, Actor } from "../src/types/action";
import type { StateDefinition } from "../src/types/state";

// ── Helpers ──────────────────────────────────────────────

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
      return Array.from(table.values()).filter((record) =>
        Object.entries(filter).every(([k, v]) => record[k] === v),
      );
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

// ── Fixtures ─────────────────────────────────────────────

const actor: Actor = {
  type: "human",
  id: "user-42",
  name: "Alice",
  groups: ["manager"],
};

const requestState: StateDefinition = {
  name: "request_state",
  schema: "request",
  field: "status",
  initial: "pending",
  states: ["pending", "approved", "rejected"],
  transitions: [
    { from: "pending", to: "approved", action: "approve_request" },
    { from: "pending", to: "rejected", action: "reject_request" },
  ],
};

// ── Tests: resolveFieldExpression (via declarative action) ─────

describe("resolveFieldExpression via declarative action", () => {
  test("$actor.id resolves to actor's ID", async () => {
    const dp = createMemoryDataProvider();
    const sm = createStateMachine(requestState);
    const executor = createActionExecutor({ dataProvider: dp, stateMachine: sm });

    const action: ActionDefinition = {
      name: "approve_request",
      schema: "request",
      label: "Approve Request",
      input: { id: { type: "string", required: true } },
      stateTransition: { from: "pending", to: "approved" },
      setFields: { approved_by: "$actor.id" },
      policy: { mode: "sync", transaction: false },
    };
    executor.registry.register(action);

    await dp.create("request", { id: "r1", status: "pending" });
    const result = await executor.execute("approve_request", { id: "r1" }, actor);

    expect(result.success).toBe(true);
    expect(result.record?.approved_by).toBe("user-42");
  });

  test("$actor.name resolves to actor's name", async () => {
    const dp = createMemoryDataProvider();
    const sm = createStateMachine(requestState);
    const executor = createActionExecutor({ dataProvider: dp, stateMachine: sm });

    const action: ActionDefinition = {
      name: "approve_request",
      schema: "request",
      label: "Approve Request",
      input: { id: { type: "string", required: true } },
      stateTransition: { from: "pending", to: "approved" },
      setFields: { approved_by_name: "$actor.name" },
      policy: { mode: "sync", transaction: false },
    };
    executor.registry.register(action);

    await dp.create("request", { id: "r1", status: "pending" });
    const result = await executor.execute("approve_request", { id: "r1" }, actor);

    expect(result.success).toBe(true);
    expect(result.record?.approved_by_name).toBe("Alice");
  });

  test("$input.reason resolves to action input field", async () => {
    const dp = createMemoryDataProvider();
    const sm = createStateMachine(requestState);
    const executor = createActionExecutor({ dataProvider: dp, stateMachine: sm });

    const action: ActionDefinition = {
      name: "approve_request",
      schema: "request",
      label: "Approve Request",
      input: {
        id: { type: "string", required: true },
        reason: { type: "string" },
      },
      stateTransition: { from: "pending", to: "approved" },
      setFields: { approval_reason: "$input.reason" },
      policy: { mode: "sync", transaction: false },
    };
    executor.registry.register(action);

    await dp.create("request", { id: "r1", status: "pending" });
    const result = await executor.execute(
      "approve_request",
      { id: "r1", reason: "Looks good" },
      actor,
    );

    expect(result.success).toBe(true);
    expect(result.record?.approval_reason).toBe("Looks good");
  });

  test("$now resolves to ISO timestamp string", async () => {
    const dp = createMemoryDataProvider();
    const sm = createStateMachine(requestState);
    const executor = createActionExecutor({ dataProvider: dp, stateMachine: sm });

    const action: ActionDefinition = {
      name: "approve_request",
      schema: "request",
      label: "Approve Request",
      input: { id: { type: "string", required: true } },
      stateTransition: { from: "pending", to: "approved" },
      setFields: { approved_at: "$now" },
      policy: { mode: "sync", transaction: false },
    };
    executor.registry.register(action);

    await dp.create("request", { id: "r1", status: "pending" });
    const before = new Date().toISOString();
    const result = await executor.execute("approve_request", { id: "r1" }, actor);
    const after = new Date().toISOString();

    expect(result.success).toBe(true);
    const approvedAt = result.record?.approved_at as string;
    // Should be a valid ISO string between before and after
    expect(approvedAt >= before).toBe(true);
    expect(approvedAt <= after).toBe(true);
  });

  test("$now.date resolves to YYYY-MM-DD format", async () => {
    const dp = createMemoryDataProvider();
    const sm = createStateMachine(requestState);
    const executor = createActionExecutor({ dataProvider: dp, stateMachine: sm });

    const action: ActionDefinition = {
      name: "approve_request",
      schema: "request",
      label: "Approve Request",
      input: { id: { type: "string", required: true } },
      stateTransition: { from: "pending", to: "approved" },
      setFields: { approved_date: "$now.date" },
      policy: { mode: "sync", transaction: false },
    };
    executor.registry.register(action);

    await dp.create("request", { id: "r1", status: "pending" });
    const result = await executor.execute("approve_request", { id: "r1" }, actor);

    expect(result.success).toBe(true);
    const approvedDate = result.record?.approved_date as string;
    // Must match YYYY-MM-DD format
    expect(approvedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Must be today's date
    const today = new Date().toISOString().slice(0, 10);
    expect(approvedDate).toBe(today);
  });

  test("plain string values pass through unchanged", async () => {
    const dp = createMemoryDataProvider();
    const sm = createStateMachine(requestState);
    const executor = createActionExecutor({ dataProvider: dp, stateMachine: sm });

    const action: ActionDefinition = {
      name: "approve_request",
      schema: "request",
      label: "Approve Request",
      input: { id: { type: "string", required: true } },
      stateTransition: { from: "pending", to: "approved" },
      setFields: { note: "auto-approved" },
      policy: { mode: "sync", transaction: false },
    };
    executor.registry.register(action);

    await dp.create("request", { id: "r1", status: "pending" });
    const result = await executor.execute("approve_request", { id: "r1" }, actor);

    expect(result.success).toBe(true);
    expect(result.record?.note).toBe("auto-approved");
  });

  test("non-string values (numbers, booleans) pass through unchanged", async () => {
    const dp = createMemoryDataProvider();
    const sm = createStateMachine(requestState);
    const executor = createActionExecutor({ dataProvider: dp, stateMachine: sm });

    const action: ActionDefinition = {
      name: "approve_request",
      schema: "request",
      label: "Approve Request",
      input: { id: { type: "string", required: true } },
      stateTransition: { from: "pending", to: "approved" },
      setFields: { priority: 5, is_urgent: true },
      policy: { mode: "sync", transaction: false },
    };
    executor.registry.register(action);

    await dp.create("request", { id: "r1", status: "pending" });
    const result = await executor.execute("approve_request", { id: "r1" }, actor);

    expect(result.success).toBe(true);
    expect(result.record?.priority).toBe(5);
    expect(result.record?.is_urgent).toBe(true);
  });
});

// ── Tests: stateTransition + setFields ─────────────────────

describe("declarative action with stateTransition + setFields", () => {
  test("correctly updates record with state and fields", async () => {
    const dp = createMemoryDataProvider();
    const sm = createStateMachine(requestState);
    const executor = createActionExecutor({ dataProvider: dp, stateMachine: sm });

    const action: ActionDefinition = {
      name: "approve_request",
      schema: "request",
      label: "Approve Request",
      input: { id: { type: "string", required: true } },
      stateTransition: { from: "pending", to: "approved" },
      setFields: { approved_by: "$actor.id", approved_at: "$now" },
      policy: { mode: "sync", transaction: false },
    };
    executor.registry.register(action);

    await dp.create("request", { id: "r1", title: "Buy supplies", status: "pending" });
    const result = await executor.execute("approve_request", { id: "r1" }, actor);

    expect(result.success).toBe(true);
    expect(result.record).toBeDefined();
    expect(result.record?.status).toBe("approved");
    expect(result.record?.approved_by).toBe("user-42");
    expect(typeof result.record?.approved_at).toBe("string");
    // Original fields preserved
    expect(result.record?.title).toBe("Buy supplies");
  });

  test("returns the updated record as data", async () => {
    const dp = createMemoryDataProvider();
    const sm = createStateMachine(requestState);
    const executor = createActionExecutor({ dataProvider: dp, stateMachine: sm });

    const action: ActionDefinition = {
      name: "approve_request",
      schema: "request",
      label: "Approve Request",
      input: { id: { type: "string", required: true } },
      stateTransition: { from: "pending", to: "approved" },
      setFields: { approved_by: "$actor.id" },
      policy: { mode: "sync", transaction: false },
    };
    executor.registry.register(action);

    await dp.create("request", { id: "r1", status: "pending" });
    const result = await executor.execute("approve_request", { id: "r1" }, actor);

    expect(result.success).toBe(true);
    // data should equal the updated record
    expect(result.data).toEqual(result.record);
  });

  test("state transition fails if current state does not match from", async () => {
    const dp = createMemoryDataProvider();
    const sm = createStateMachine(requestState);
    const executor = createActionExecutor({ dataProvider: dp, stateMachine: sm });

    const action: ActionDefinition = {
      name: "approve_request",
      schema: "request",
      label: "Approve Request",
      input: { id: { type: "string", required: true } },
      stateTransition: { from: "pending", to: "approved" },
      policy: { mode: "sync", transaction: false },
    };
    executor.registry.register(action);

    // Seed record already in "approved" state — not matching "from: pending"
    await dp.create("request", { id: "r1", status: "approved" });
    const result = await executor.execute("approve_request", { id: "r1" }, actor);

    expect(result.success).toBe(false);
    const error = (result.data as Record<string, unknown>).error as string;
    expect(error).toContain("State transition not allowed");
    expect(error).toContain("approved");
  });
});

// ── Tests: declarative action without handler ──────────────

describe("declarative action without handler", () => {
  test("action with only stateTransition (no setFields, no handler) works", async () => {
    const dp = createMemoryDataProvider();
    const sm = createStateMachine(requestState);
    const executor = createActionExecutor({ dataProvider: dp, stateMachine: sm });

    const action: ActionDefinition = {
      name: "approve_request",
      schema: "request",
      label: "Approve Request",
      input: { id: { type: "string", required: true } },
      stateTransition: { from: "pending", to: "approved" },
      policy: { mode: "sync", transaction: false },
    };
    executor.registry.register(action);

    await dp.create("request", { id: "r1", status: "pending" });
    const result = await executor.execute("approve_request", { id: "r1" }, actor);

    expect(result.success).toBe(true);
    expect(result.record?.status).toBe("approved");
  });

  test("action with only setFields (no stateTransition, no handler) works", async () => {
    const dp = createMemoryDataProvider();
    const executor = createActionExecutor({ dataProvider: dp });

    const action: ActionDefinition = {
      name: "tag_request",
      schema: "request",
      label: "Tag Request",
      input: { id: { type: "string", required: true } },
      setFields: { tagged_by: "$actor.id", tag: "important" },
      policy: { mode: "sync", transaction: false },
    };
    executor.registry.register(action);

    await dp.create("request", { id: "r1", title: "Fix bug", status: "pending" });
    const result = await executor.execute("tag_request", { id: "r1" }, actor);

    expect(result.success).toBe(true);
    expect(result.record?.tagged_by).toBe("user-42");
    expect(result.record?.tag).toBe("important");
    // Original fields preserved
    expect(result.record?.title).toBe("Fix bug");
    expect(result.record?.status).toBe("pending");
  });
});
