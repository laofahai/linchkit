/**
 * Command Layer + Permission Engine integration tests.
 *
 * Tests the permission slot wired to the real PermissionRegistry + checkActionPermission.
 */

import { describe, expect, test } from "bun:test";
import { PipelineError } from "../src/engine/command-layer";
import { checkActionPermission, PermissionRegistry } from "../src/engine/permission-engine";
import type { Actor } from "../src/types/action";
import type { PermissionGroupDefinition } from "../src/types/permission";
import { createTestSetup } from "./command-layer-helpers";

// ── Helpers ─────────────────────────────────────────────

/** Permission group that grants create_item and admin_action on "item" schema */
const EDITOR_GROUP: PermissionGroupDefinition = {
  name: "editor",
  label: "Editor",
  permissions: {
    item: {
      item: {
        actions: { create_item: true, admin_action: false },
      },
    },
  },
};

const ADMIN_GROUP: PermissionGroupDefinition = {
  name: "admin",
  label: "Admin",
  permissions: {
    item: {
      item: {
        actions: { create_item: true, admin_action: true },
      },
    },
  },
};

const SYSTEM_ADMIN_GROUP: PermissionGroupDefinition = {
  name: "system_admin",
  label: "System Admin",
  permissions: {},
};

/**
 * Create a permission middleware handler that uses the real permission engine.
 * Uses `action.entity` as the capability name (natural mapping for tests).
 */
function createPermissionMiddleware(registry: PermissionRegistry) {
  return async (
    ctx: { actor: Actor; action?: { entity: string; name: string } },
    next: () => Promise<void>,
  ) => {
    const action = ctx.action;
    if (!action) {
      await next();
      return;
    }
    const result = checkActionPermission(registry, ctx.actor, action.entity, action.name);
    if (!result.allowed) {
      throw new PipelineError(result.reason ?? "Permission denied", "PERMISSION.DENIED");
    }
    await next();
  };
}

// ── Tests ───────────────────────────────────────────────

describe("Command Layer + Permission Engine Integration", () => {
  test("permission middleware blocks unauthorized action", async () => {
    const { layer } = createTestSetup();
    const registry = new PermissionRegistry();
    registry.register(EDITOR_GROUP);

    // Actor belongs to "editor" group which explicitly denies admin_action
    layer.use({
      name: "test_auth",
      slot: "auth",
      handler: async (ctx, next) => {
        ctx.actor = {
          type: "human",
          id: "user_1",
          groups: ["editor"],
        };
        await next();
      },
    });

    layer.use({
      name: "perm_engine",
      slot: "permission",
      handler: createPermissionMiddleware(registry),
    });

    const result = await layer.execute({
      command: "admin_action",
      input: {},
    });

    expect(result.success).toBe(false);
    const data = result.data as Record<string, unknown>;
    expect(data.code).toBe("PERMISSION.DENIED");
  });

  test("permission middleware allows authorized action", async () => {
    const { layer } = createTestSetup();
    const registry = new PermissionRegistry();
    registry.register(ADMIN_GROUP);

    layer.use({
      name: "test_auth",
      slot: "auth",
      handler: async (ctx, next) => {
        ctx.actor = {
          type: "human",
          id: "admin_1",
          groups: ["admin"],
        };
        await next();
      },
    });

    layer.use({
      name: "perm_engine",
      slot: "permission",
      handler: createPermissionMiddleware(registry),
    });

    const result = await layer.execute({
      command: "admin_action",
      input: {},
    });

    expect(result.success).toBe(true);
  });

  test("system_admin bypasses permission check", async () => {
    const { layer } = createTestSetup();
    const registry = new PermissionRegistry();
    registry.register(SYSTEM_ADMIN_GROUP);

    layer.use({
      name: "test_auth",
      slot: "auth",
      handler: async (ctx, next) => {
        ctx.actor = {
          type: "human",
          id: "root",
          groups: ["system_admin"],
        };
        await next();
      },
    });

    layer.use({
      name: "perm_engine",
      slot: "permission",
      handler: createPermissionMiddleware(registry),
    });

    // admin_action requires "admin" group normally, but system_admin bypasses
    const result = await layer.execute({
      command: "admin_action",
      input: {},
    });

    expect(result.success).toBe(true);
  });

  test("no permission middleware = executor built-in check still runs (fail-closed)", async () => {
    const { layer } = createTestSetup();

    // No permission middleware registered — executor's built-in permission check runs
    // admin_action requires groups: ["admin"], anonymous has none → rejected
    const result = await layer.execute({
      command: "admin_action",
      input: {},
    });

    expect(result.success).toBe(false);
    const data = result.data as Record<string, unknown>;
    expect(data.error as string).toContain("required groups");
  });

  test("no permission middleware + unrestricted action = allow", async () => {
    const { layer } = createTestSetup();

    // create_item has no permissions defined — passes executor's built-in check
    const result = await layer.execute({
      command: "create_item",
      input: { name: "test" },
    });

    expect(result.success).toBe(true);
  });

  test("no auth middleware = anonymous actor (default)", async () => {
    const { layer } = createTestSetup();
    let capturedActor: Actor | undefined;

    // No auth middleware — actor stays anonymous
    layer.use({
      name: "capture",
      slot: "pre-action",
      handler: async (ctx, next) => {
        capturedActor = ctx.actor;
        await next();
      },
    });

    await layer.execute({
      command: "create_item",
      input: { name: "anon_test" },
    });

    expect(capturedActor).toBeDefined();
    expect(capturedActor?.id).toBe("anonymous");
    expect(capturedActor?.type).toBe("system");
    expect(capturedActor?.groups).toEqual([]);
  });

  test("auth + permission full pipeline integration", async () => {
    const { layer } = createTestSetup();
    const registry = new PermissionRegistry();
    registry.register(EDITOR_GROUP);
    registry.register(ADMIN_GROUP);

    // Auth middleware that reads a token header to determine role
    layer.use({
      name: "token_auth",
      slot: "auth",
      handler: async (ctx, next) => {
        const token = ctx.headers?.authorization;
        if (token === "Bearer admin-token") {
          ctx.actor = {
            type: "human",
            id: "admin_1",
            groups: ["admin"],
          };
        } else if (token === "Bearer editor-token") {
          ctx.actor = {
            type: "human",
            id: "editor_1",
            groups: ["editor"],
          };
        }
        // No token → stays anonymous
        await next();
      },
    });

    layer.use({
      name: "perm_engine",
      slot: "permission",
      handler: createPermissionMiddleware(registry),
    });

    // Admin can execute admin_action
    const adminResult = await layer.execute({
      command: "admin_action",
      input: {},
      channel: "http",
      headers: { authorization: "Bearer admin-token" },
    });
    expect(adminResult.success).toBe(true);

    // Editor is explicitly denied admin_action
    const { layer: layer2 } = createTestSetup();
    const registry2 = new PermissionRegistry();
    registry2.register(EDITOR_GROUP);
    registry2.register(ADMIN_GROUP);

    layer2.use({
      name: "token_auth",
      slot: "auth",
      handler: async (ctx, next) => {
        const token = ctx.headers?.authorization;
        if (token === "Bearer editor-token") {
          ctx.actor = {
            type: "human",
            id: "editor_1",
            groups: ["editor"],
          };
        }
        await next();
      },
    });

    layer2.use({
      name: "perm_engine",
      slot: "permission",
      handler: createPermissionMiddleware(registry2),
    });

    const editorResult = await layer2.execute({
      command: "admin_action",
      input: {},
      channel: "http",
      headers: { authorization: "Bearer editor-token" },
    });
    expect(editorResult.success).toBe(false);
    const data = editorResult.data as Record<string, unknown>;
    expect(data.code).toBe("PERMISSION.DENIED");
  });

  test("anonymous actor with permission middleware is denied (no groups)", async () => {
    const { layer } = createTestSetup();
    const registry = new PermissionRegistry();
    registry.register(ADMIN_GROUP);

    // No auth middleware — stays anonymous with empty groups
    layer.use({
      name: "perm_engine",
      slot: "permission",
      handler: createPermissionMiddleware(registry),
    });

    const result = await layer.execute({
      command: "admin_action",
      input: {},
    });

    expect(result.success).toBe(false);
    const data = result.data as Record<string, unknown>;
    expect(data.code).toBe("PERMISSION.DENIED");
  });

  test("editor can execute create_item but not admin_action", async () => {
    const { layer } = createTestSetup();
    const registry = new PermissionRegistry();
    registry.register(EDITOR_GROUP);

    layer.use({
      name: "test_auth",
      slot: "auth",
      handler: async (ctx, next) => {
        ctx.actor = {
          type: "human",
          id: "editor_1",
          groups: ["editor"],
        };
        await next();
      },
    });

    layer.use({
      name: "perm_engine",
      slot: "permission",
      handler: createPermissionMiddleware(registry),
    });

    // Editor CAN create_item (explicitly allowed)
    const createResult = await layer.execute({
      command: "create_item",
      input: { name: "new_item" },
    });
    expect(createResult.success).toBe(true);

    // Editor CANNOT admin_action (explicitly denied)
    const { layer: layer2 } = createTestSetup();
    const registry2 = new PermissionRegistry();
    registry2.register(EDITOR_GROUP);

    layer2.use({
      name: "test_auth",
      slot: "auth",
      handler: async (ctx, next) => {
        ctx.actor = {
          type: "human",
          id: "editor_1",
          groups: ["editor"],
        };
        await next();
      },
    });

    layer2.use({
      name: "perm_engine",
      slot: "permission",
      handler: createPermissionMiddleware(registry2),
    });

    const adminResult = await layer2.execute({
      command: "admin_action",
      input: {},
    });
    expect(adminResult.success).toBe(false);
  });
});
