/**
 * Tenant Isolation — unit tests.
 *
 * Covers:
 * - createTenantAwareDataProvider: query isolation, create auto-set, cross-tenant rejection
 * - createTenantIsolationMiddleware: tenant slot wiring, system actor bypass, requireTenant
 */

import { describe, expect, mock, test } from "bun:test";
import type { DataProvider } from "../src/engine/action-engine";
import { AuthorizationError } from "../src/errors";
import {
  createTenantAwareDataProvider,
  createTenantIsolationMiddleware,
  defaultTenantResolver,
} from "../src/security/tenant-isolation";

// ── Mock DataProvider ────────────────────────────────────────

function createMockProvider(): DataProvider & {
  _calls: Array<{ method: string; args: unknown[] }>;
} {
  const calls: Array<{ method: string; args: unknown[] }> = [];

  return {
    _calls: calls,
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
      return 5;
    },
  };
}

// ── createTenantAwareDataProvider ────────────────────────────

describe("createTenantAwareDataProvider", () => {
  const TENANT_ID = "tenant_abc";

  test("query() injects tenantId into options", async () => {
    const base = createMockProvider();
    const wrapped = createTenantAwareDataProvider(base, TENANT_ID);

    await wrapped.query("orders", { status: "open" });

    expect(base._calls).toHaveLength(1);
    expect(base._calls[0]!.method).toBe("query");
    expect(base._calls[0]!.args[2]).toEqual({ tenantId: TENANT_ID });
  });

  test("query() preserves existing options while injecting tenantId", async () => {
    const base = createMockProvider();
    const wrapped = createTenantAwareDataProvider(base, TENANT_ID);

    await wrapped.query("orders", {}, { includeDeleted: true });

    expect(base._calls[0]!.args[2]).toEqual({
      tenantId: TENANT_ID,
      includeDeleted: true,
    });
  });

  test("get() injects tenantId into options", async () => {
    const base = createMockProvider();
    const wrapped = createTenantAwareDataProvider(base, TENANT_ID);

    await wrapped.get("orders", "order-1");

    expect(base._calls[0]!.args[2]).toEqual({ tenantId: TENANT_ID });
  });

  test("create() auto-sets tenant_id on the record", async () => {
    const base = createMockProvider();
    const wrapped = createTenantAwareDataProvider(base, TENANT_ID);

    await wrapped.create("orders", { name: "New Order" });

    const createdData = base._calls[0]!.args[1] as Record<string, unknown>;
    expect(createdData.tenant_id).toBe(TENANT_ID);
    expect(createdData.name).toBe("New Order");
  });

  test("create() allows matching tenant_id in data", async () => {
    const base = createMockProvider();
    const wrapped = createTenantAwareDataProvider(base, TENANT_ID);

    await wrapped.create("orders", { name: "Order", tenant_id: TENANT_ID });

    const createdData = base._calls[0]!.args[1] as Record<string, unknown>;
    expect(createdData.tenant_id).toBe(TENANT_ID);
  });

  test("create() rejects cross-tenant tenant_id", async () => {
    const base = createMockProvider();
    const wrapped = createTenantAwareDataProvider(base, TENANT_ID);

    expect(
      wrapped.create("orders", { name: "Order", tenant_id: "other_tenant" }),
    ).rejects.toThrow(AuthorizationError);
  });

  test("update() injects tenantId and rejects cross-tenant write", async () => {
    const base = createMockProvider();
    const wrapped = createTenantAwareDataProvider(base, TENANT_ID);

    // Normal update should inject tenantId
    await wrapped.update("orders", "order-1", { name: "Updated" });
    expect(base._calls[0]!.args[3]).toEqual({ tenantId: TENANT_ID });

    // Cross-tenant update should be rejected
    expect(
      wrapped.update("orders", "order-1", { tenant_id: "other_tenant" }),
    ).rejects.toThrow(AuthorizationError);
  });

  test("delete() injects tenantId into options", async () => {
    const base = createMockProvider();
    const wrapped = createTenantAwareDataProvider(base, TENANT_ID);

    await wrapped.delete("orders", "order-1");

    expect(base._calls[0]!.args[2]).toEqual({ tenantId: TENANT_ID });
  });

  test("count() injects tenantId into options", async () => {
    const base = createMockProvider();
    const wrapped = createTenantAwareDataProvider(base, TENANT_ID);

    await wrapped.count("orders", { status: "open" });

    expect(base._calls[0]!.args[2]).toEqual({ tenantId: TENANT_ID });
  });

  test("create() allows null/undefined tenant_id (auto-set)", async () => {
    const base = createMockProvider();
    const wrapped = createTenantAwareDataProvider(base, TENANT_ID);

    await wrapped.create("orders", { name: "A", tenant_id: null });
    await wrapped.create("orders", { name: "B", tenant_id: undefined });

    // Both should have been auto-set
    const data1 = base._calls[0]!.args[1] as Record<string, unknown>;
    const data2 = base._calls[1]!.args[1] as Record<string, unknown>;
    expect(data1.tenant_id).toBe(TENANT_ID);
    expect(data2.tenant_id).toBe(TENANT_ID);
  });
});

// ── defaultTenantResolver ────────────────────────────────────

describe("defaultTenantResolver", () => {
  test("resolves tenantId from actor.tenantId", () => {
    const result = defaultTenantResolver.resolve({
      actor: { type: "user", id: "u1", groups: [], tenantId: "t99" },
      meta: {},
    });
    expect(result).toBe("t99");
  });

  test("returns undefined for system actor (bypass)", () => {
    const result = defaultTenantResolver.resolve({
      actor: { type: "system", id: "sys", groups: [], tenantId: "t99" },
      meta: {},
    });
    expect(result).toBeUndefined();
  });

  test("returns undefined when actor has no tenantId", () => {
    const result = defaultTenantResolver.resolve({
      actor: { type: "user", id: "u1", groups: [] },
      meta: {},
    });
    expect(result).toBeUndefined();
  });
});

// ── createTenantIsolationMiddleware ──────────────────────────

describe("createTenantIsolationMiddleware", () => {
  test("sets ctx.tenantId from actor", async () => {
    const mw = createTenantIsolationMiddleware();
    expect(mw.slot).toBe("tenant");
    expect(mw.name).toBe("tenant_isolation");

    const ctx = {
      command: "create_order",
      input: {},
      channel: "http" as const,
      actor: { type: "user", id: "u1", groups: [], tenantId: "t_abc" },
      meta: {},
    };

    const next = mock(async () => {});
    await mw.handler(ctx, next);

    expect(ctx.tenantId).toBe("t_abc");
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("system actor bypasses (tenantId stays undefined)", async () => {
    const mw = createTenantIsolationMiddleware();

    const ctx = {
      command: "admin_task",
      input: {},
      channel: "internal" as const,
      actor: { type: "system", id: "sys", groups: [] },
      tenantId: undefined as string | undefined,
      meta: {},
    };

    const next = mock(async () => {});
    await mw.handler(ctx, next);

    expect(ctx.tenantId).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("requireTenant=true rejects non-system actor without tenantId", async () => {
    const mw = createTenantIsolationMiddleware({ requireTenant: true });

    const ctx = {
      command: "create_order",
      input: {},
      channel: "http" as const,
      actor: { type: "user", id: "u1", groups: [] },
      meta: {},
    };

    const next = mock(async () => {});
    await expect(mw.handler(ctx, next)).rejects.toThrow(AuthorizationError);
    expect(next).not.toHaveBeenCalled();
  });

  test("requireTenant=false allows non-system actor without tenantId", async () => {
    const mw = createTenantIsolationMiddleware({ requireTenant: false });

    const ctx = {
      command: "create_order",
      input: {},
      channel: "http" as const,
      actor: { type: "user", id: "u1", groups: [] },
      tenantId: undefined as string | undefined,
      meta: {},
    };

    const next = mock(async () => {});
    await mw.handler(ctx, next);

    expect(ctx.tenantId).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("custom resolver is used when provided", async () => {
    const mw = createTenantIsolationMiddleware({
      resolver: {
        resolve: (ctx) => (ctx.headers?.["x-tenant-id"] as string) ?? undefined,
      },
    });

    const ctx = {
      command: "create_order",
      input: {},
      channel: "http" as const,
      actor: { type: "user", id: "u1", groups: [] },
      headers: { "x-tenant-id": "t_from_header" },
      meta: {},
    };

    const next = mock(async () => {});
    await mw.handler(ctx, next);

    expect(ctx.tenantId).toBe("t_from_header");
  });
});
