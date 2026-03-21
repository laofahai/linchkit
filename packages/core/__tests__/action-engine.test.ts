import { describe, expect, it } from "bun:test";
import {
  ActionRegistry,
  createActionExecutor,
  type DataProvider,
} from "../src/engine/action-engine";
import { createStateMachine } from "../src/engine/state-machine";
import type { ActionDefinition, Actor } from "../src/types/action";
import type { StateDefinition } from "../src/types/state";

// ── Test fixtures ───────────────────────────────────────

const defaultActor: Actor = {
  type: "human",
  id: "user-1",
  groups: ["admin"],
};

const simpleAction: ActionDefinition = {
  name: "create_order",
  schema: "order",
  label: "Create Order",
  input: {
    title: { type: "string", required: true },
    amount: { type: "number" },
  },
  policy: { mode: "sync", transaction: true },
  handler: async (ctx) => {
    const record = await ctx.create("order", {
      title: ctx.input.title,
      amount: ctx.input.amount,
    });
    return record;
  },
};

const declarativeAction: ActionDefinition = {
  name: "submit_order",
  schema: "order",
  label: "Submit Order",
  input: {
    id: { type: "ref", target: "order", required: true },
  },
  stateTransition: { from: "draft", to: "submitted" },
  setFields: { submitted_at: "now" },
  policy: { mode: "sync", transaction: true },
};

const restrictedAction: ActionDefinition = {
  name: "approve_order",
  schema: "order",
  label: "Approve Order",
  permissions: {
    groups: ["manager", "admin"],
    actorTypes: ["human"],
  },
  policy: { mode: "sync", transaction: true },
  handler: async () => ({ approved: true }),
};

const exposedAction: ActionDefinition = {
  name: "internal_sync",
  schema: "order",
  label: "Internal Sync",
  exposure: {
    internal: true,
    http: false,
    mcp: false,
    cli: false,
    ui: false,
  },
  policy: { mode: "sync", transaction: false },
  handler: async () => ({ synced: true }),
};

const validatedAction: ActionDefinition = {
  name: "finalize_order",
  schema: "order",
  label: "Finalize Order",
  validate: {
    required: ["title", "amount"],
  },
  policy: { mode: "sync", transaction: true },
  handler: async () => ({ finalized: true }),
};

const customValidatedAction: ActionDefinition = {
  name: "special_order",
  schema: "order",
  label: "Special Order",
  validate: {
    custom: (ctx) => {
      if ((ctx.input.amount as number) > 10000) {
        return {
          valid: false,
          errors: [{ field: "amount", message: "Amount exceeds limit" }],
        };
      }
      return { valid: true };
    },
  },
  policy: { mode: "sync", transaction: true },
  handler: async () => ({ ok: true }),
};

// ── In-memory DataProvider ──────────────────────────────

function createMemoryDataProvider(): DataProvider {
  const store = new Map<string, Map<string, Record<string, unknown>>>();

  function getTable(schema: string): Map<string, Record<string, unknown>> {
    if (!store.has(schema)) {
      store.set(schema, new Map());
    }
    return store.get(schema)!;
  }

  return {
    async get(schema, id) {
      const table = getTable(schema);
      const record = table.get(id);
      if (!record) {
        throw new Error(`Record not found: ${schema}/${id}`);
      }
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
      const id = data.id as string || `id_${table.size + 1}`;
      const record = { ...data, id };
      table.set(id, record);
      return record;
    },
    async update(schema, id, data) {
      const table = getTable(schema);
      const existing = table.get(id);
      if (!existing) {
        throw new Error(`Record not found: ${schema}/${id}`);
      }
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

// ── State machine fixture ───────────────────────────────

const orderStateDefinition: StateDefinition = {
  name: "order_state",
  schema: "order",
  field: "status",
  initial: "draft",
  states: ["draft", "submitted", "approved", "rejected"],
  transitions: [
    { from: "draft", to: "submitted", action: "submit_order" },
    { from: "submitted", to: "approved", action: "approve_order" },
    { from: "submitted", to: "rejected", action: "reject_order" },
  ],
};

// ── Tests ───────────────────────────────────────────────

describe("ActionRegistry", () => {
  it("registers and retrieves an action", () => {
    const registry = new ActionRegistry();
    registry.register(simpleAction);

    const result = registry.get("create_order");
    expect(result).toBeDefined();
    expect(result!.name).toBe("create_order");
  });

  it("returns undefined for unknown action", () => {
    const registry = new ActionRegistry();
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("checks existence with has()", () => {
    const registry = new ActionRegistry();
    registry.register(simpleAction);

    expect(registry.has("create_order")).toBe(true);
    expect(registry.has("nonexistent")).toBe(false);
  });

  it("lists all actions", () => {
    const registry = new ActionRegistry();
    registry.register(simpleAction);
    registry.register(declarativeAction);

    const all = registry.getAll();
    expect(all).toHaveLength(2);
  });

  it("filters actions by schema", () => {
    const registry = new ActionRegistry();
    registry.register(simpleAction);
    registry.register({
      ...declarativeAction,
      name: "other_action",
      schema: "other_schema",
    });

    const orderActions = registry.getBySchema("order");
    expect(orderActions).toHaveLength(1);
    expect(orderActions[0].name).toBe("create_order");
  });

  it("rejects duplicate action names", () => {
    const registry = new ActionRegistry();
    registry.register(simpleAction);

    expect(() => registry.register(simpleAction)).toThrow(
      'Action "create_order" is already registered',
    );
  });
});

describe("ActionExecutor", () => {
  it("executes a simple handler action", async () => {
    const dataProvider = createMemoryDataProvider();
    const executor = createActionExecutor({ dataProvider });
    executor.registry.register(simpleAction);

    const result = await executor.execute(
      "create_order",
      { title: "Test Order", amount: 100 },
      defaultActor,
    );

    expect(result.success).toBe(true);
    expect(result.executionId).toBeDefined();
    expect(result.data).toBeDefined();
    expect((result.data as Record<string, unknown>).title).toBe("Test Order");
  });

  it("executes a declarative action with setFields", async () => {
    const dataProvider = createMemoryDataProvider();
    const stateMachine = createStateMachine(orderStateDefinition);
    const executor = createActionExecutor({ dataProvider, stateMachine });
    executor.registry.register(declarativeAction);

    // Seed a record
    await dataProvider.create("order", {
      id: "order-1",
      title: "Test",
      status: "draft",
    });

    const result = await executor.execute(
      "submit_order",
      { id: "order-1" },
      defaultActor,
    );

    expect(result.success).toBe(true);
    expect(result.record).toBeDefined();
    expect(result.record!.status).toBe("submitted");
    expect(result.record!.submitted_at).toBe("now");
  });

  it("returns failure for unknown action", async () => {
    const dataProvider = createMemoryDataProvider();
    const executor = createActionExecutor({ dataProvider });

    const result = await executor.execute("nonexistent", {}, defaultActor);

    expect(result.success).toBe(false);
  });

  it("rejects unauthorized actor type", async () => {
    const dataProvider = createMemoryDataProvider();
    const executor = createActionExecutor({ dataProvider });
    executor.registry.register(restrictedAction);

    const aiActor: Actor = { type: "ai", id: "bot-1", groups: ["admin"] };
    const result = await executor.execute("approve_order", {}, aiActor);

    expect(result.success).toBe(false);
    expect((result.data as Record<string, unknown>).error).toContain(
      'Actor type "ai" is not allowed',
    );
  });

  it("rejects unauthorized role", async () => {
    const dataProvider = createMemoryDataProvider();
    const executor = createActionExecutor({ dataProvider });
    executor.registry.register(restrictedAction);

    const viewerActor: Actor = { type: "human", id: "user-2", groups: ["viewer"] };
    const result = await executor.execute("approve_order", {}, viewerActor);

    expect(result.success).toBe(false);
    expect((result.data as Record<string, unknown>).error).toContain(
      "does not belong to any of the required groups",
    );
  });

  it("rejects missing required input", async () => {
    const dataProvider = createMemoryDataProvider();
    const executor = createActionExecutor({ dataProvider });
    executor.registry.register(simpleAction);

    const result = await executor.execute("create_order", { amount: 100 }, defaultActor);

    expect(result.success).toBe(false);
    expect((result.data as Record<string, unknown>).error).toBe("Input validation failed");
  });

  it("runs validate.required pre-validation", async () => {
    const dataProvider = createMemoryDataProvider();
    const executor = createActionExecutor({ dataProvider });
    executor.registry.register(validatedAction);

    // Missing "title" and "amount" in input
    const result = await executor.execute("finalize_order", {}, defaultActor);

    expect(result.success).toBe(false);
    expect((result.data as Record<string, unknown>).error).toBe("Validation failed");
    const details = (result.data as Record<string, unknown>).details as Array<{
      field: string;
    }>;
    expect(details.some((d) => d.field === "title")).toBe(true);
    expect(details.some((d) => d.field === "amount")).toBe(true);
  });

  it("runs validate.custom and blocks execution", async () => {
    const dataProvider = createMemoryDataProvider();
    const executor = createActionExecutor({ dataProvider });
    executor.registry.register(customValidatedAction);

    const result = await executor.execute(
      "special_order",
      { amount: 50000 },
      defaultActor,
    );

    expect(result.success).toBe(false);
    const details = (result.data as Record<string, unknown>).details as Array<{
      field: string;
      message: string;
    }>;
    expect(details[0].message).toBe("Amount exceeds limit");
  });

  it("blocks invalid state transition", async () => {
    const dataProvider = createMemoryDataProvider();
    const stateMachine = createStateMachine(orderStateDefinition);
    const executor = createActionExecutor({ dataProvider, stateMachine });
    executor.registry.register(declarativeAction);

    // Seed a record in "submitted" state — transition requires "draft"
    await dataProvider.create("order", {
      id: "order-2",
      title: "Test",
      status: "submitted",
    });

    const result = await executor.execute(
      "submit_order",
      { id: "order-2" },
      defaultActor,
    );

    expect(result.success).toBe(false);
    expect((result.data as Record<string, unknown>).error).toContain(
      "State transition not allowed",
    );
  });

  it("succeeds with valid state transition", async () => {
    const dataProvider = createMemoryDataProvider();
    const stateMachine = createStateMachine(orderStateDefinition);
    const executor = createActionExecutor({ dataProvider, stateMachine });
    executor.registry.register(declarativeAction);

    // Seed a record in "draft" state
    await dataProvider.create("order", {
      id: "order-3",
      title: "Test",
      status: "draft",
    });

    const result = await executor.execute(
      "submit_order",
      { id: "order-3" },
      defaultActor,
    );

    expect(result.success).toBe(true);
    expect(result.record!.status).toBe("submitted");
  });

  it("rejects action not exposed for channel", async () => {
    const dataProvider = createMemoryDataProvider();
    const executor = createActionExecutor({ dataProvider });
    executor.registry.register(exposedAction);

    // Try via HTTP — should be blocked
    const result = await executor.execute(
      "internal_sync",
      {},
      defaultActor,
      { channel: "http" },
    );

    expect(result.success).toBe(false);
    expect((result.data as Record<string, unknown>).error).toContain(
      'not exposed for channel "http"',
    );

    // Try via internal — should work
    const result2 = await executor.execute(
      "internal_sync",
      {},
      defaultActor,
      { channel: "internal" },
    );

    expect(result2.success).toBe(true);
  });
});
