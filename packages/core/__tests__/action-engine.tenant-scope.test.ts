/**
 * Action engine — tenant stamping on execution-log entries (#500).
 *
 * The evolution sense loop tenant-scopes its `execution_log` reads, which only
 * works if the WRITER tags each entry with the acting tenant. These tests lock
 * that contract: the resolved `execOptions.tenantId` lands on the log entry and
 * is visible only to that tenant's scoped read, and is left unset when no tenant
 * is in scope (single-tenant / dev).
 *
 * Kept in a focused module (action-engine.test.ts is already at the 500-line cap).
 */

import { describe, expect, it } from "bun:test";
import { createActionExecutor, type DataProvider } from "../src/engine/action-engine";
import { InMemoryExecutionLogger } from "../src/observability/execution-logger";
import type { ActionDefinition, Actor } from "../src/types/action";

const defaultActor: Actor = { type: "human", id: "user-1", groups: ["admin"] };

const simpleAction: ActionDefinition = {
  name: "create_order",
  entity: "order",
  label: "Create Order",
  input: {
    title: { type: "string", required: true },
    amount: { type: "number" },
  },
  policy: { mode: "sync", transaction: true },
  handler: async (ctx) => ctx.create("order", { title: ctx.input.title, amount: ctx.input.amount }),
};

function createMemoryDataProvider(): DataProvider {
  const store = new Map<string, Map<string, Record<string, unknown>>>();
  function getTable(schema: string): Map<string, Record<string, unknown>> {
    if (!store.has(schema)) store.set(schema, new Map());
    const table = store.get(schema);
    if (!table) throw new Error(`Unreachable: store missing key ${schema}`);
    return table;
  }
  return {
    async get(schema, id) {
      const record = getTable(schema).get(id);
      if (!record) throw new Error(`Record not found: ${schema}/${id}`);
      return record;
    },
    async query(schema, filter) {
      return Array.from(getTable(schema).values()).filter((record) =>
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
      getTable(schema).delete(id);
    },
  };
}

describe("ActionExecutor tenant scoping (#500)", () => {
  it("stamps execOptions.tenantId onto the execution log entry", async () => {
    const dataProvider = createMemoryDataProvider();
    const executionLogger = new InMemoryExecutionLogger();
    const executor = createActionExecutor({ dataProvider, executionLogger });
    executor.registry.register(simpleAction);

    await executor.execute("create_order", { title: "Scoped", amount: 1 }, defaultActor, {
      tenantId: "tenant-a",
    });

    // The single log entry must carry the resolved tenant so tenant-scoped
    // reads (evolution sensors) can filter execution_log by tenant.
    const scoped = executionLogger.findMany({ tenantId: "tenant-a" });
    expect(scoped.items).toHaveLength(1);
    expect(scoped.items[0]?.tenantId).toBe("tenant-a");
    // And it is NOT visible to a different tenant's scoped read.
    expect(executionLogger.findMany({ tenantId: "tenant-b" }).items).toHaveLength(0);
  });

  it("leaves execution log entry tenantId unset when no tenant is in scope", async () => {
    const dataProvider = createMemoryDataProvider();
    const executionLogger = new InMemoryExecutionLogger();
    const executor = createActionExecutor({ dataProvider, executionLogger });
    executor.registry.register(simpleAction);

    await executor.execute("create_order", { title: "Unscoped", amount: 1 }, defaultActor);

    const all = executionLogger.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.tenantId).toBeUndefined();
  });
});
