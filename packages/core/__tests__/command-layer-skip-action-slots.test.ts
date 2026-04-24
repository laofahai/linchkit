/**
 * Command Layer — non-action dispatch (`skipActionSlots`) tests.
 *
 * Covers the synthetic success result produced when the pipeline runs auth /
 * permission / tenant middlewares without executing an action (used by the
 * entity onchange REST route, Spec 64 §4.3). The result must expose the
 * resolved `tenantId` and `locale` read from the final command context so
 * downstream handlers can propagate them without re-parsing the request.
 */

import { describe, expect, test } from "bun:test";
import { createActionExecutor } from "../src/engine/action-engine";
import { createCommandLayer } from "../src/engine/command-layer";
import { createTestDataProvider } from "./command-layer-helpers";

/**
 * Register a no-op permission middleware on the given layer. The fail-closed
 * guard for `skipActionSlots` requires at least one permission middleware —
 * tests that focus on other behaviors need this stub to pass the guard.
 */
function registerNoopPermissionMiddleware(
  layer: ReturnType<typeof createCommandLayer>,
  name = "test_permission",
): void {
  layer.use({
    name,
    slot: "permission",
    handler: async (_ctx, next) => {
      await next();
    },
  });
}

describe("Command Layer: skipActionSlots synthetic result", () => {
  test("carries tenantId and locale resolved by middleware, plus skipped marker", async () => {
    const executor = createActionExecutor({ dataProvider: createTestDataProvider() });
    const layer = createCommandLayer({ executor });
    registerNoopPermissionMiddleware(layer);

    // Tenant middleware mutates `ctx.tenantId` — the synthetic result must
    // reflect the middleware-resolved value, not whatever the caller passed.
    layer.use({
      name: "test_tenant",
      slot: "tenant",
      handler: async (ctx, next) => {
        ctx.tenantId = "tenant_from_middleware";
        ctx.locale = "zh-CN";
        await next();
      },
    });

    const result = await layer.execute({
      command: "customer.onchange",
      input: { entity: "customer", changedField: "name" },
      skipActionSlots: true,
    });

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.skipped).toBe(true);
    expect(data.tenantId).toBe("tenant_from_middleware");
    expect(data.locale).toBe("zh-CN");
  });

  test("tenantId defaults to undefined when no middleware sets it", async () => {
    const executor = createActionExecutor({ dataProvider: createTestDataProvider() });
    const layer = createCommandLayer({ executor });
    registerNoopPermissionMiddleware(layer);

    const result = await layer.execute({
      command: "customer.onchange",
      input: {},
      skipActionSlots: true,
    });

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.skipped).toBe(true);
    expect(data.tenantId).toBeUndefined();
    expect(data.locale).toBeUndefined();
  });

  test("initial tenantId from execute options survives if middleware does not override", async () => {
    const executor = createActionExecutor({ dataProvider: createTestDataProvider() });
    const layer = createCommandLayer({ executor });
    registerNoopPermissionMiddleware(layer);

    const result = await layer.execute({
      command: "customer.onchange",
      input: {},
      tenantId: "tenant_from_caller",
      locale: "en",
      skipActionSlots: true,
    });

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.tenantId).toBe("tenant_from_caller");
    expect(data.locale).toBe("en");
  });
});

describe("Command Layer: skipActionSlots hardening guards", () => {
  test("returns PERMISSION.MIDDLEWARE_MISSING when skipActionSlots is true and no permission middleware is registered", async () => {
    const executor = createActionExecutor({ dataProvider: createTestDataProvider() });
    const layer = createCommandLayer({ executor });
    // Intentionally NO permission middleware registered.

    const result = await layer.execute({
      command: "customer.onchange",
      input: { entity: "customer", changedField: "name" },
      skipActionSlots: true,
    });

    expect(result.success).toBe(false);
    const data = result.data as Record<string, unknown>;
    expect(data.code).toBe("PERMISSION.MIDDLEWARE_MISSING");
    expect(typeof data.error).toBe("string");
  });

  test("returns COMMAND.INVALID_OPTIONS when skipActionSlots and approvalId are both set", async () => {
    const executor = createActionExecutor({ dataProvider: createTestDataProvider() });
    // verifyApproval is configured so approvalId would otherwise be honored —
    // the guard must reject the combination BEFORE verifyApproval runs.
    let verifyCalled = false;
    const layer = createCommandLayer({
      executor,
      verifyApproval: async () => {
        verifyCalled = true;
        return true;
      },
    });
    // Permission middleware registered so Finding 1 doesn't fire first.
    registerNoopPermissionMiddleware(layer);

    const result = await layer.execute({
      command: "customer.onchange",
      input: {},
      skipActionSlots: true,
      approvalId: "appr_test",
    });

    expect(result.success).toBe(false);
    const data = result.data as Record<string, unknown>;
    expect(data.code).toBe("COMMAND.INVALID_OPTIONS");
    expect(typeof data.error).toBe("string");
    // Guard must short-circuit before verifyApproval is consulted.
    expect(verifyCalled).toBe(false);
  });

  test("skipActionSlots succeeds when permission middleware is registered and no approvalId", async () => {
    const executor = createActionExecutor({ dataProvider: createTestDataProvider() });
    const layer = createCommandLayer({ executor });
    registerNoopPermissionMiddleware(layer);

    const result = await layer.execute({
      command: "customer.onchange",
      input: { entity: "customer", changedField: "name" },
      skipActionSlots: true,
    });

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.skipped).toBe(true);
  });
});
