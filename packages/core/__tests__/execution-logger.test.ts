import { describe, expect, it } from "bun:test";
import { createActionExecutor, type DataProvider } from "../src/engine/action-engine";
import { InMemoryExecutionLogger } from "../src/observability/execution-logger";
import type { ActionDefinition, Actor } from "../src/types/action";

// ── Test fixtures ───────────────────────────────────────

const defaultActor: Actor = {
  type: "human",
  id: "user-1",
  groups: ["admin"],
};

const createOrderAction: ActionDefinition = {
  name: "create_order",
  entity: "order",
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
  entity: "order",
  label: "Failing Action",
  policy: { mode: "sync", transaction: true },
  handler: async () => {
    throw new Error("Something went wrong");
  },
};

const parentAction: ActionDefinition = {
  name: "parent_action",
  entity: "order",
  label: "Parent Action",
  policy: { mode: "sync", transaction: true },
  handler: async (ctx) => {
    await ctx.execute("child_action", { value: 1 });
    return { done: true };
  },
};

const childAction: ActionDefinition = {
  name: "child_action",
  entity: "order",
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
      entity: "order",
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

    logger.log({ ...base, id: "e1", action: "create_order", entity: "order" });
    logger.log({ ...base, id: "e2", action: "delete_order", entity: "order" });
    logger.log({ ...base, id: "e3", action: "create_order", entity: "order" });

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

    logger.log({ ...base, id: "e1", action: "a1", entity: "order" });
    logger.log({ ...base, id: "e2", action: "a2", entity: "product" });

    expect(logger.getByEntity("order")).toHaveLength(1);
    expect(logger.getByEntity("product")).toHaveLength(1);
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
    expect(entry.entity).toBe("order");
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

  // Removed: "should log blocked actions (permission denied)" — the Action
  // Engine no longer performs permission checks (issue #125). Permission
  // denial is now emitted by the CommandLayer pipeline as a PipelineError,
  // which the execution logger records via its own path (covered by
  // command-layer-permission.test.ts).

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

// ── Spec 65 §9 — Execution log records meta snapshot ──────

describe("ExecutionLogger — meta snapshot recording (Spec 65 §9)", () => {
  it("records caller-provided meta on a successful execution", async () => {
    const logger = new InMemoryExecutionLogger();
    const executor = createActionExecutor({
      dataProvider: createMockDataProvider(),
      executionLogger: logger,
    });

    executor.registry.register(createOrderAction);
    await executor.execute("create_order", { title: "Bulk Order", amount: 100 }, defaultActor, {
      meta: { bulk: true, source_view: "queue" },
      channel: "http",
    });

    const entry = logger.getAll()[0];
    expect(entry.meta).toBeDefined();
    expect(entry.meta?.bulk).toBe(true);
    expect(entry.meta?.source_view).toBe("queue");
    // System keys stamped by ActionEngine flow into the log too.
    expect(entry.meta?._channel).toBe("http");
    expect(entry.meta?._depth).toBe(0);
    expect(entry.meta?._execution_id).toBe(entry.id);
  });

  it("records meta on a failed execution (handler throws)", async () => {
    const logger = new InMemoryExecutionLogger();
    const executor = createActionExecutor({
      dataProvider: createMockDataProvider(),
      executionLogger: logger,
    });

    executor.registry.register(failingAction);
    await executor.execute("failing_action", {}, defaultActor, {
      meta: { triggered_by: "scheduler" },
    });

    const entry = logger.getAll()[0];
    expect(entry.status).toBe("failed");
    expect(entry.meta?.triggered_by).toBe("scheduler");
  });

  it("records meta when the action is not found", async () => {
    const logger = new InMemoryExecutionLogger();
    const executor = createActionExecutor({
      dataProvider: createMockDataProvider(),
      executionLogger: logger,
    });

    await executor.execute("missing_action", {}, defaultActor, {
      meta: { source_view: "console" },
    });

    const entry = logger.getAll()[0];
    expect(entry.status).toBe("failed");
    expect(entry.meta?.source_view).toBe("console");
  });

  it("strips _-prefixed external keys from logged meta (system keys win)", async () => {
    const logger = new InMemoryExecutionLogger();
    const executor = createActionExecutor({
      dataProvider: createMockDataProvider(),
      executionLogger: logger,
    });

    executor.registry.register(createOrderAction);
    await executor.execute("create_order", { title: "x" }, defaultActor, {
      meta: { _channel: "spoofed", _execution_id: "fake", source_view: "real" },
      channel: "http",
    });

    const entry = logger.getAll()[0];
    // External _channel attempt rejected; framework re-stamps from execOptions.channel.
    expect(entry.meta?._channel).toBe("http");
    expect(entry.meta?._execution_id).toBe(entry.id);
    expect(entry.meta?.source_view).toBe("real");
  });

  it("propagates parent meta into child execution log entries", async () => {
    const logger = new InMemoryExecutionLogger();
    const executor = createActionExecutor({
      dataProvider: createMockDataProvider(),
      executionLogger: logger,
    });

    executor.registry.register(parentAction);
    executor.registry.register(childAction);

    await executor.execute("parent_action", {}, defaultActor, {
      meta: { bulk: true },
    });

    const parentEntry = logger.getByAction("parent_action")[0];
    const childEntry = logger.getByAction("child_action")[0];

    expect(parentEntry.meta?.bulk).toBe(true);
    // Child inherits parent's meta keys via extendExecutionMeta.
    expect(childEntry.meta?.bulk).toBe(true);
    // Child has its own _depth + _source_action.
    expect(childEntry.meta?._depth).toBe(1);
    expect(childEntry.meta?._source_action).toBe("parent_action");
  });
});
