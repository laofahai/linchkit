/**
 * Tenant-scoped ActionExecutor — integration tests.
 *
 * Verifies that when tenantId is provided in ExecuteOptions,
 * the ActionExecutor wraps the DataProvider with createTenantAwareDataProvider
 * so all CRUD operations enforce row-level tenant isolation.
 */

import { describe, expect, it } from "bun:test";
import {
  createActionExecutor,
  type DataProvider,
  type DataQueryOptions,
} from "../src/engine/action-engine";
import type { ActionDefinition, Actor } from "../src/types/action";

// ── Spy DataProvider — records all calls with their arguments ──

interface SpyCall {
  method: string;
  args: unknown[];
}

function createSpyDataProvider(): DataProvider & { calls: SpyCall[] } {
  const calls: SpyCall[] = [];

  return {
    calls,
    async get(schema, id, options?) {
      calls.push({ method: "get", args: [schema, id, options] });
      return { id, tenant_id: "t1", name: "test" };
    },
    async query(schema, filter, options?) {
      calls.push({ method: "query", args: [schema, filter, options] });
      return [{ id: "1", tenant_id: "t1" }];
    },
    async create(schema, data) {
      calls.push({ method: "create", args: [schema, data] });
      return { id: "new-1", ...data };
    },
    async update(schema, id, data, options?) {
      calls.push({ method: "update", args: [schema, id, data, options] });
      return { id, ...data };
    },
    async delete(schema, id, options?) {
      calls.push({ method: "delete", args: [schema, id, options] });
    },
    async count(schema, filter?, options?) {
      calls.push({ method: "count", args: [schema, filter, options] });
      return 0;
    },
  };
}

// ── Fixtures ──

const actor: Actor = { type: "human", id: "user-1", groups: ["admin"] };
const TENANT_A = "tenant_a";
const TENANT_B = "tenant_b";

const crudAction: ActionDefinition = {
  name: "crud_test",
  schema: "orders",
  label: "CRUD Test",
  input: {},
  policy: { mode: "sync", transaction: false },
  handler: async (ctx) => {
    // Exercise all data operations
    await ctx.create("orders", { title: "New order" });
    await ctx.get("orders", "rec-1");
    await ctx.query("orders", { status: "open" });
    await ctx.update("orders", "rec-1", { title: "Updated" });
    await ctx.delete("orders", "rec-1");
    return { done: true };
  },
};

// ── Tests ──

describe("Tenant-scoped ActionExecutor", () => {
  it("wraps DataProvider with tenant isolation when tenantId is present", async () => {
    const spy = createSpyDataProvider();
    const executor = createActionExecutor({ dataProvider: spy });
    executor.registry.register(crudAction);

    await executor.execute("crud_test", {}, actor, { tenantId: TENANT_A });

    // create() should have tenant_id auto-set
    const createCall = spy.calls.find((c) => c.method === "create");
    expect(createCall).toBeDefined();
    const createData = createCall?.args[1] as Record<string, unknown>;
    expect(createData.tenant_id).toBe(TENANT_A);

    // get() should pass tenantId in options
    const getCall = spy.calls.find((c) => c.method === "get");
    expect(getCall).toBeDefined();
    const getOptions = getCall?.args[2] as DataQueryOptions;
    expect(getOptions.tenantId).toBe(TENANT_A);

    // query() should pass tenantId in options
    const queryCall = spy.calls.find((c) => c.method === "query");
    expect(queryCall).toBeDefined();
    const queryOptions = queryCall?.args[2] as DataQueryOptions;
    expect(queryOptions.tenantId).toBe(TENANT_A);

    // update() should pass tenantId in options
    const updateCall = spy.calls.find((c) => c.method === "update");
    expect(updateCall).toBeDefined();
    const updateOptions = updateCall?.args[3] as DataQueryOptions;
    expect(updateOptions.tenantId).toBe(TENANT_A);

    // delete() should pass tenantId in options
    const deleteCall = spy.calls.find((c) => c.method === "delete");
    expect(deleteCall).toBeDefined();
    const deleteOptions = deleteCall?.args[2] as DataQueryOptions;
    expect(deleteOptions.tenantId).toBe(TENANT_A);
  });

  it("does NOT wrap DataProvider when tenantId is absent", async () => {
    const spy = createSpyDataProvider();
    const executor = createActionExecutor({ dataProvider: spy });
    executor.registry.register(crudAction);

    await executor.execute("crud_test", {}, actor);

    // create() should NOT have tenant_id
    const createCall = spy.calls.find((c) => c.method === "create");
    const createData = createCall?.args[1] as Record<string, unknown>;
    expect(createData.tenant_id).toBeUndefined();

    // get() should not have tenantId in options (may be undefined or no options)
    const getCall = spy.calls.find((c) => c.method === "get");
    const getOptions = getCall?.args[2] as DataQueryOptions | undefined;
    expect(getOptions?.tenantId).toBeUndefined();
  });

  it("blocks cross-tenant create via ctx.create()", async () => {
    const spy = createSpyDataProvider();
    const executor = createActionExecutor({ dataProvider: spy });

    const crossTenantAction: ActionDefinition = {
      name: "cross_tenant_create",
      schema: "orders",
      label: "Cross Tenant Create",
      input: {},
      policy: { mode: "sync", transaction: false },
      handler: async (ctx) => {
        // Attempt to create a record with a different tenant_id
        await ctx.create("orders", { title: "Hack", tenant_id: TENANT_B });
        return { done: true };
      },
    };
    executor.registry.register(crossTenantAction);

    const result = await executor.execute("cross_tenant_create", {}, actor, {
      tenantId: TENANT_A,
    });

    // Should fail because createTenantAwareDataProvider rejects cross-tenant writes
    expect(result.success).toBe(false);
    expect(String((result.data as Record<string, unknown>).error)).toContain(
      "Cannot create record",
    );
  });

  it("blocks cross-tenant update via ctx.update()", async () => {
    const spy = createSpyDataProvider();
    const executor = createActionExecutor({ dataProvider: spy });

    const crossTenantUpdate: ActionDefinition = {
      name: "cross_tenant_update",
      schema: "orders",
      label: "Cross Tenant Update",
      input: {},
      policy: { mode: "sync", transaction: false },
      handler: async (ctx) => {
        await ctx.update("orders", "rec-1", { tenant_id: TENANT_B });
        return { done: true };
      },
    };
    executor.registry.register(crossTenantUpdate);

    const result = await executor.execute("cross_tenant_update", {}, actor, {
      tenantId: TENANT_A,
    });

    expect(result.success).toBe(false);
    expect(String((result.data as Record<string, unknown>).error)).toContain(
      "Cannot change tenant_id",
    );
  });

  it("allows same-tenant create (explicit tenant_id matches)", async () => {
    const spy = createSpyDataProvider();
    const executor = createActionExecutor({ dataProvider: spy });

    const sameTenantAction: ActionDefinition = {
      name: "same_tenant_create",
      schema: "orders",
      label: "Same Tenant Create",
      input: {},
      policy: { mode: "sync", transaction: false },
      handler: async (ctx) => {
        await ctx.create("orders", { title: "OK", tenant_id: TENANT_A });
        return { done: true };
      },
    };
    executor.registry.register(sameTenantAction);

    const result = await executor.execute("same_tenant_create", {}, actor, {
      tenantId: TENANT_A,
    });

    expect(result.success).toBe(true);
    const createCall = spy.calls.find((c) => c.method === "create");
    const createData = createCall?.args[1] as Record<string, unknown>;
    expect(createData.tenant_id).toBe(TENANT_A);
  });

  it("propagates tenantId to child action executions", async () => {
    const spy = createSpyDataProvider();
    const executor = createActionExecutor({ dataProvider: spy });

    const childAction: ActionDefinition = {
      name: "child_action",
      schema: "items",
      label: "Child Action",
      input: {},
      policy: { mode: "sync", transaction: false },
      handler: async (ctx) => {
        await ctx.create("items", { name: "item" });
        return { created: true };
      },
    };

    const parentAction: ActionDefinition = {
      name: "parent_action",
      schema: "orders",
      label: "Parent Action",
      input: {},
      policy: { mode: "sync", transaction: false },
      handler: async (ctx) => {
        await ctx.create("orders", { title: "Parent order" });
        await ctx.execute("child_action", {});
        return { done: true };
      },
    };

    executor.registry.register(childAction);
    executor.registry.register(parentAction);

    await executor.execute("parent_action", {}, actor, { tenantId: TENANT_A });

    // Both parent and child creates should have tenant_id set
    const createCalls = spy.calls.filter((c) => c.method === "create");
    expect(createCalls.length).toBe(2);

    for (const call of createCalls) {
      const data = call.args[1] as Record<string, unknown>;
      expect(data.tenant_id).toBe(TENANT_A);
    }
  });
});
