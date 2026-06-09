import { describe, expect, it } from "bun:test";
import type { CommandContext } from "@linchkit/core";
import { AuthorizationError, definePermissionGroup } from "@linchkit/core";
import { PermissionRegistry } from "@linchkit/core/server";
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
      entity: "purchase_request",
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

/**
 * Meta-target permission resolution (`skipActionSlots` dispatch).
 *
 * The onchange / evolution routes dispatch through CommandLayer with
 * `skipActionSlots: true` and NO `ctx.action`; their synthetic command name is a
 * metrics label only, and the authoritative permission target is published in
 * `ctx.meta` (`meta.evolution = { operation }`). `command-layer.ts` documents
 * this contract — these tests pin that the middleware HONOURS it: a natural grant
 * (`grant.evolution.actions.<operation>`) authorizes the dispatch, a missing grant
 * is denied, and a real action dispatch is never affected by a stray `meta`.
 */
describe("permission middleware — meta.evolution target (skipActionSlots dispatch)", () => {
  /** A run-cycle-shaped dispatch: synthetic command, no action, meta target. */
  function runCycleCtx(actor: CommandContext["actor"]): CommandContext {
    return {
      command: "evolution.run_cycle",
      input: {},
      channel: "http",
      actor,
      meta: { evolution: { operation: "run_cycle" } },
      // No `action` — this is a non-action dispatch (skipActionSlots).
    } as CommandContext;
  }

  function registryWithEvolutionGrant(): PermissionRegistry {
    const registry = new PermissionRegistry();
    registry.register(
      definePermissionGroup({
        name: "evolution_operator",
        label: "Evolution Operator",
        // The NATURAL grant shape a human would author for the run-cycle target.
        grant: { evolution: { actions: { run_cycle: true } } },
      }),
    );
    return registry;
  }

  it("authorizes run-cycle via grant.evolution.actions.run_cycle (the documented target)", async () => {
    const middleware = createPermissionMiddleware({ registry: registryWithEvolutionGrant() });
    const ctx = runCycleCtx({ type: "human", id: "op_1", groups: ["evolution_operator"] });
    let nextCalled = false;

    await middleware(ctx, async () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
  });

  it("denies run-cycle when the actor's groups grant no evolution target", async () => {
    const middleware = createPermissionMiddleware({ registry: registryWithEvolutionGrant() });
    const ctx = runCycleCtx({ type: "human", id: "stranger", groups: ["some_unrelated_group"] });

    await expect(middleware(ctx, async () => {})).rejects.toThrow(AuthorizationError);
  });

  it("denies run-cycle when the synthetic command name was the only thing granted (regression)", async () => {
    // Before the meta-target fix the middleware gated on the synthetic command
    // name. Granting THAT must NOT authorize the operation — the target is the
    // meta operation, so this still denies. Guards against a silent regression to
    // command-name gating.
    const registry = new PermissionRegistry();
    registry.register(
      definePermissionGroup({
        name: "command_name_only",
        label: "Command-name grant (wrong shape)",
        grant: { "evolution.run_cycle": { actions: { "evolution.run_cycle": true } } },
      }),
    );
    const middleware = createPermissionMiddleware({ registry });
    const ctx = runCycleCtx({ type: "human", id: "op_2", groups: ["command_name_only"] });

    await expect(middleware(ctx, async () => {})).rejects.toThrow(AuthorizationError);
  });

  it("ignores a stray meta.evolution on a real ACTION dispatch (target stays the action)", async () => {
    // Defensive: meta-target resolution is scoped to non-action dispatches. A real
    // action carrying meta.evolution must still authorize against its action target
    // (here `submit_request`), never silently switch to the evolution target.
    const registry = createTestRegistry();
    const middleware = createPermissionMiddleware({ registry });
    const ctx = createTestContext({
      meta: { evolution: { operation: "run_cycle" } },
    });
    let nextCalled = false;

    await middleware(ctx, async () => {
      nextCalled = true;
    });

    // `editors` grants `submit_request` (the action target), proving the action
    // path won — the evolution meta was ignored because `ctx.action` is present.
    expect(nextCalled).toBe(true);
  });
});
