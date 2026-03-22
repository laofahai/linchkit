import { describe, expect, it } from "bun:test";
import type { CommandContext } from "@linchkit/core";
import { AuthorizationError, definePermissionGroup, PermissionRegistry } from "@linchkit/core";
import { createPermissionMiddleware } from "../src/middleware/permission-middleware";

/** Helper to create a minimal CommandContext for testing */
function createTestContext(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    command: "submit_request",
    input: {},
    channel: "http",
    actor: { type: "human", id: "user_001", groups: ["editors"] },
    meta: {},
    action: {
      name: "submit_request",
      schema: "purchase_request",
      label: "Submit",
      policy: { mode: "sync", transaction: true },
    },
    ...overrides,
  };
}

function createTestRegistry(): PermissionRegistry {
  const registry = new PermissionRegistry();

  registry.register(
    definePermissionGroup({
      name: "editors",
      label: "Editors",
      permissions: {
        purchase_request: {
          purchase_request: {
            actions: { submit_request: true, delete_request: false },
            data: {
              read: "all",
              write: {
                condition: {
                  field: "created_by",
                  operator: "eq",
                  value: "$actor.id",
                },
              },
            },
            fields: {
              hidden: ["internal_notes"],
            },
          },
        },
      },
    }),
  );

  registry.register(
    definePermissionGroup({
      name: "system_admin",
      label: "System Admin",
      permissions: {},
    }),
  );

  return registry;
}

describe("permission middleware", () => {
  it("should allow action when permission is granted", async () => {
    const registry = createTestRegistry();
    const middleware = createPermissionMiddleware({ registry });
    const ctx = createTestContext();
    let nextCalled = false;

    await middleware(ctx, async () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
  });

  it("should deny action when permission is explicitly denied", async () => {
    const registry = createTestRegistry();
    const middleware = createPermissionMiddleware({ registry });
    const ctx = createTestContext({ command: "delete_request" });

    await expect(middleware(ctx, async () => {})).rejects.toThrow(AuthorizationError);
  });

  it("should deny action when no group grants it", async () => {
    const registry = createTestRegistry();
    const middleware = createPermissionMiddleware({ registry });
    const ctx = createTestContext({ command: "unknown_action" });

    await expect(middleware(ctx, async () => {})).rejects.toThrow(AuthorizationError);
  });

  it("should skip check for public actions", async () => {
    const registry = createTestRegistry();
    const middleware = createPermissionMiddleware({
      registry,
      publicActions: ["login"],
    });
    const ctx = createTestContext({
      command: "login",
      actor: { type: "system", id: "anonymous", groups: [] },
    });
    let nextCalled = false;

    await middleware(ctx, async () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
  });

  it("should skip check for trusted system actors", async () => {
    const registry = createTestRegistry();
    const middleware = createPermissionMiddleware({ registry });
    const ctx = createTestContext({
      actor: { type: "system", id: "internal_worker", groups: [] },
    });
    let nextCalled = false;

    await middleware(ctx, async () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
  });

  it("should inject data access conditions into ctx.meta", async () => {
    const registry = createTestRegistry();
    const middleware = createPermissionMiddleware({ registry });
    const ctx = createTestContext();

    await middleware(ctx, async () => {});

    const dataAccess = ctx.meta.dataAccess as {
      read: string;
      write: { field: string; operator: string; value: string };
    };
    expect(dataAccess).toBeDefined();
    expect(dataAccess.read).toBe("all");
    // Write condition should have $actor.id resolved to user_001
    expect(dataAccess.write).toEqual({
      field: "created_by",
      operator: "eq",
      value: "user_001",
    });
  });

  it("should inject field access permissions into ctx.meta", async () => {
    const registry = createTestRegistry();
    const middleware = createPermissionMiddleware({ registry });
    const ctx = createTestContext();

    await middleware(ctx, async () => {});

    const fieldAccess = ctx.meta.fieldAccess as { hidden: string[] };
    expect(fieldAccess).toBeDefined();
    expect(fieldAccess.hidden).toContain("internal_notes");
  });

  it("should allow system_admin actors all actions", async () => {
    const registry = createTestRegistry();
    const middleware = createPermissionMiddleware({ registry });
    const ctx = createTestContext({
      actor: { type: "human", id: "admin_001", groups: ["system_admin"] },
      command: "delete_request",
    });
    let nextCalled = false;

    await middleware(ctx, async () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
  });
});
