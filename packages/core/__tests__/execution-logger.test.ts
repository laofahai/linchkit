import { describe, expect, it } from "bun:test";
import { createActionExecutor, type DataProvider } from "../src/engine/action-engine";
import { InMemoryExecutionLogger } from "../src/engine/execution-logger";
import type { ActionDefinition, Actor } from "../src/types/action";

// ── Test fixtures ───────────────────────────────────────

const defaultActor: Actor = {
  type: "human",
  id: "user-1",
  groups: ["admin"],
};

const createOrderAction: ActionDefinition = {
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

const failingAction: ActionDefinition = {
  name: "failing_action",
  schema: "order",
  label: "Failing Action",
  policy: { mode: "sync", transaction: true },
  handler: async () => {
    throw new Error("Something went wrong");
  },
};

const restrictedAction: ActionDefinition = {
  name: "restricted_action",
  schema: "order",
  label: "Restricted",
  permissions: {
    groups: ["superadmin"],
  },
  policy: { mode: "sync", transaction: true },
  handler: async () => ({ ok: true }),
};

const parentAction: ActionDefinition = {
  name: "parent_action",
  schema: "order",
  label: "Parent Action",
  policy: { mode: "sync", transaction: true },
  handler: async (ctx) => {
    await ctx.execute("child_action", { value: 1 });
    return { done: true };
  },
};

const childAction: ActionDefinition = {
  name: "child_action",
  schema: "order",
  label: "Child Action",
  policy: { mode: "sync", transaction: true },
  handler: async () => ({ child: true }),
};

function createMockDataProvider(): DataProvider {
  const store = new Map<string, Record<string, unknown>>();
  return {
    get: async (schema, id) => {
      const record = store.get(`${schema}:${id}`);
      if (!record) throw new Error("Not found");
      return record;
    },
    query: async () => [],
    create: async (schema, data) => {
      const id = `${schema}_${Date.now()}`;
      const record = { id, ...data };
      store.set(`${schema}:${id}`, record);
      return record;
    },
    update: async (schema, id, data) => {
      const existing = store.get(`${schema}:${id}`) || { id };
      const updated = { ...existing, ...data };
      store.set(`${schema}:${id}`, updated);
      return updated;
    },
    delete: async (schema, id) => {
      store.delete(`${schema}:${id}`);
    },
  };
}

// ── InMemoryExecutionLogger unit tests ──────────────────

describe("InMemoryExecutionLogger", () => {
  it("should store and retrieve log entries", () => {
    const logger = new InMemoryExecutionLogger();

    const entry = {
      id: "exec_1",
      action: "create_order",
      schema: "order",
      actor: defaultActor,
      input: { title: "Test" },
      status: "succeeded" as const,
      duration: 10,
      startedAt: new Date(),
      completedAt: new Date(),
    };

    logger.log(entry);
    expect(logger.size).toBe(1);
    expect(logger.getAll()).toHaveLength(1);
    expect(logger.getById("exec_1")).toEqual(entry);
  });

  it("should filter by action name", () => {
    const logger = new InMemoryExecutionLogger();
    const base = {
      actor: defaultActor,
      input: {},
      status: "succeeded" as const,
      duration: 5,
      startedAt: new Date(),
      completedAt: new Date(),
    };

    logger.log({ ...base, id: "e1", action: "create_order", schema: "order" });
    logger.log({ ...base, id: "e2", action: "delete_order", schema: "order" });
    logger.log({ ...base, id: "e3", action: "create_order", schema: "order" });

    expect(logger.getByAction("create_order")).toHaveLength(2);
    expect(logger.getByAction("delete_order")).toHaveLength(1);
    expect(logger.getByAction("nonexistent")).toHaveLength(0);
  });

  it("should filter by schema name", () => {
    const logger = new InMemoryExecutionLogger();
    const base = {
      actor: defaultActor,
      input: {},
      status: "succeeded" as const,
      duration: 5,
      startedAt: new Date(),
      completedAt: new Date(),
    };

    logger.log({ ...base, id: "e1", action: "a1", schema: "order" });
    logger.log({ ...base, id: "e2", action: "a2", schema: "product" });

    expect(logger.getBySchema("order")).toHaveLength(1);
    expect(logger.getBySchema("product")).toHaveLength(1);
  });

  it("should filter by status", () => {
    const logger = new InMemoryExecutionLogger();
    const base = {
      actor: defaultActor,
      input: {},
      action: "test",
      duration: 5,
      startedAt: new Date(),
      completedAt: new Date(),
    };

    logger.log({ ...base, id: "e1", status: "succeeded" as const });
    logger.log({ ...base, id: "e2", status: "failed" as const });
    logger.log({ ...base, id: "e3", status: "blocked" as const });
    logger.log({ ...base, id: "e4", status: "succeeded" as const });

    expect(logger.getByStatus("succeeded")).toHaveLength(2);
    expect(logger.getByStatus("failed")).toHaveLength(1);
    expect(logger.getByStatus("blocked")).toHaveLength(1);
  });

  it("should clear all entries", () => {
    const logger = new InMemoryExecutionLogger();
    logger.log({
      id: "e1",
      action: "test",
      actor: defaultActor,
      input: {},
      status: "succeeded",
      duration: 5,
      startedAt: new Date(),
      completedAt: new Date(),
    });

    expect(logger.size).toBe(1);
    logger.clear();
    expect(logger.size).toBe(0);
    expect(logger.getAll()).toHaveLength(0);
  });
});

// ── ActionExecutor + ExecutionLogger integration ────────

describe("ActionExecutor with ExecutionLogger", () => {
  it("should log successful action executions", async () => {
    const logger = new InMemoryExecutionLogger();
    const executor = createActionExecutor({
      dataProvider: createMockDataProvider(),
      executionLogger: logger,
    });

    executor.registry.register(createOrderAction);
    const result = await executor.execute(
      "create_order",
      { title: "Test Order", amount: 100 },
      defaultActor,
    );

    expect(result.success).toBe(true);
    expect(logger.size).toBe(1);

    const entry = logger.getAll()[0];
    expect(entry.action).toBe("create_order");
    expect(entry.schema).toBe("order");
    expect(entry.status).toBe("succeeded");
    expect(entry.actor).toEqual(defaultActor);
    expect(entry.input).toEqual({ title: "Test Order", amount: 100 });
    expect(entry.duration).toBeGreaterThanOrEqual(0);
    expect(entry.startedAt).toBeInstanceOf(Date);
    expect(entry.completedAt).toBeInstanceOf(Date);
  });

  it("should log failed action executions (handler error)", async () => {
    const logger = new InMemoryExecutionLogger();
    const executor = createActionExecutor({
      dataProvider: createMockDataProvider(),
      executionLogger: logger,
    });

    executor.registry.register(failingAction);
    const result = await executor.execute("failing_action", {}, defaultActor);

    expect(result.success).toBe(false);
    expect(logger.size).toBe(1);

    const entry = logger.getAll()[0];
    expect(entry.status).toBe("failed");
    expect(entry.error?.message).toBe("Something went wrong");
  });

  it("should log blocked actions (permission denied)", async () => {
    const logger = new InMemoryExecutionLogger();
    const executor = createActionExecutor({
      dataProvider: createMockDataProvider(),
      executionLogger: logger,
    });

    executor.registry.register(restrictedAction);
    const lowPrivActor: Actor = { type: "human", id: "user-2", groups: ["viewer"] };
    const result = await executor.execute("restricted_action", {}, lowPrivActor);

    expect(result.success).toBe(false);
    expect(logger.size).toBe(1);

    const entry = logger.getAll()[0];
    expect(entry.status).toBe("blocked");
    expect(entry.error?.message).toContain("does not belong to any of the required groups");
  });

  it("should log when action is not found", async () => {
    const logger = new InMemoryExecutionLogger();
    const executor = createActionExecutor({
      dataProvider: createMockDataProvider(),
      executionLogger: logger,
    });

    const result = await executor.execute("nonexistent_action", {}, defaultActor);

    expect(result.success).toBe(false);
    expect(logger.size).toBe(1);

    const entry = logger.getAll()[0];
    expect(entry.status).toBe("failed");
    expect(entry.error?.message).toContain("not found");
  });

  it("should track child execution IDs", async () => {
    const logger = new InMemoryExecutionLogger();
    const executor = createActionExecutor({
      dataProvider: createMockDataProvider(),
      executionLogger: logger,
    });

    executor.registry.register(parentAction);
    executor.registry.register(childAction);

    const result = await executor.execute("parent_action", {}, defaultActor);

    expect(result.success).toBe(true);
    expect(logger.size).toBe(2); // parent + child

    const parentEntry = logger.getByAction("parent_action")[0];
    const childEntry = logger.getByAction("child_action")[0];

    expect(parentEntry.childExecutionIds).toHaveLength(1);
    expect(parentEntry.childExecutionIds?.[0]).toBe(childEntry.id);
  });

  it("should not break when no logger is provided", async () => {
    const executor = createActionExecutor({
      dataProvider: createMockDataProvider(),
      // No executionLogger
    });

    executor.registry.register(createOrderAction);
    const result = await executor.execute("create_order", { title: "Test" }, defaultActor);

    expect(result.success).toBe(true);
  });
});
