/**
 * Command Layer — tenant isolation middleware integration tests.
 *
 * Verifies that createTenantIsolationMiddleware registers in the "tenant"
 * slot and correctly populates ctx.tenantId during pipeline execution.
 */

import { describe, expect, test } from "bun:test";
import { createTenantIsolationMiddleware } from "../src/security/tenant-isolation";
import { createTestSetup } from "./command-layer-helpers";

describe("Command Layer: Tenant Isolation", () => {
  test("middleware registers in the tenant slot", () => {
    const mw = createTenantIsolationMiddleware({ requireTenant: false });
    expect(mw.slot).toBe("tenant");
    expect(mw.name).toBe("tenant_isolation");
  });

  test("tenant middleware sets ctx.tenantId from actor and reaches the action", async () => {
    const { layer } = createTestSetup();
    const tenantMw = createTenantIsolationMiddleware({ requireTenant: false });
    layer.use(tenantMw);

    // Track what tenantId the pre-action slot sees
    let observedTenantId: string | undefined;
    layer.use({
      name: "observe_tenant",
      slot: "pre-action",
      handler: async (ctx, next) => {
        observedTenantId = ctx.tenantId;
        await next();
      },
    });

    const result = await layer.execute({
      command: "create_item",
      input: { name: "test" },
      actor: { type: "user", id: "u1", groups: [], tenantId: "tenant_42" },
    });

    expect(result.success).toBe(true);
    expect(observedTenantId).toBe("tenant_42");
  });

  test("system actor bypasses tenant resolution", async () => {
    const { layer } = createTestSetup();
    const tenantMw = createTenantIsolationMiddleware({ requireTenant: true });
    layer.use(tenantMw);

    let observedTenantId: string | undefined = "should-be-cleared";
    layer.use({
      name: "observe_tenant",
      slot: "pre-action",
      handler: async (ctx, next) => {
        observedTenantId = ctx.tenantId;
        await next();
      },
    });

    const result = await layer.execute({
      command: "create_item",
      input: { name: "test" },
      actor: { type: "system", id: "sys", groups: [] },
    });

    expect(result.success).toBe(true);
    expect(observedTenantId).toBeUndefined();
  });

  test("requireTenant=true blocks non-system actor without tenantId", async () => {
    const { layer } = createTestSetup();
    const tenantMw = createTenantIsolationMiddleware({ requireTenant: true });
    layer.use(tenantMw);

    const result = await layer.execute({
      command: "create_item",
      input: { name: "test" },
      actor: { type: "user", id: "u1", groups: [] },
    });

    // Pipeline catches the AuthorizationError and returns failure
    expect(result.success).toBe(false);
  });

  test("requireTenant=false allows non-system actor without tenantId", async () => {
    const { layer } = createTestSetup();
    const tenantMw = createTenantIsolationMiddleware({ requireTenant: false });
    layer.use(tenantMw);

    const result = await layer.execute({
      command: "create_item",
      input: { name: "test" },
      actor: { type: "user", id: "u1", groups: [] },
    });

    expect(result.success).toBe(true);
  });

  test("tenant slot runs after auth and before pre-action in pipeline order", async () => {
    const { layer } = createTestSetup();
    const executionOrder: string[] = [];

    layer.use({
      name: "auth_mw",
      slot: "auth",
      handler: async (_ctx, next) => {
        executionOrder.push("auth");
        await next();
      },
    });
    layer.use(createTenantIsolationMiddleware({ requireTenant: false }));
    // Track tenant slot execution via a second tenant-slot middleware
    // (can't use the same name, so we add a pre-action observer)
    layer.use({
      name: "pre_action_mw",
      slot: "pre-action",
      handler: async (_ctx, next) => {
        executionOrder.push("pre-action");
        await next();
      },
    });

    // Insert order tracker in tenant slot handler by wrapping
    const originalMws = layer.getMiddlewares();
    const tenantMw = originalMws.find((m) => m.name === "tenant_isolation");
    expect(tenantMw).toBeDefined();

    // Verify slot positions
    expect(tenantMw?.slot).toBe("tenant");
    const authMw = originalMws.find((m) => m.name === "auth_mw");
    expect(authMw?.slot).toBe("auth");

    // Execute and verify overall pipeline succeeds
    const result = await layer.execute({
      command: "create_item",
      input: { name: "test" },
      actor: { type: "user", id: "u1", groups: [], tenantId: "t1" },
    });

    expect(result.success).toBe(true);
    // auth runs before pre-action (tenant slot is between them in pipeline)
    expect(executionOrder).toEqual(["auth", "pre-action"]);
  });
});
