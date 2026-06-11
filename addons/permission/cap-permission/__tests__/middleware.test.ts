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

/**
 * Meta-target permission resolution — `meta.onchange` (Spec 64 onchange route).
 *
 * The onchange route dispatches with `skipActionSlots: true`, NO `ctx.action`, and
 * publishes `meta.onchange = { entity, changedField }`. `command-layer.ts`
 * documents that the permission middleware should derive an entity-level READ
 * check from this meta (not look up an action named "onchange"). These tests pin
 * that the middleware HONOURS it: an actor with READ access to the entity is
 * allowed, one without is denied, and a stray `meta.onchange` on a real action
 * dispatch is ignored.
 */
describe("permission middleware — meta.onchange target (skipActionSlots dispatch)", () => {
  /** An onchange-shaped dispatch: synthetic command, no action, meta read target. */
  function onchangeCtx(actor: CommandContext["actor"]): CommandContext {
    return {
      command: "invoice.onchange",
      input: {},
      channel: "http",
      actor,
      meta: { onchange: { entity: "invoice", changedField: "amount" } },
      // No `action` — non-action dispatch (skipActionSlots).
    } as CommandContext;
  }

  /** A registry whose `invoice_reader` group grants READ access to `invoice`. */
  function registryWithInvoiceRead(): PermissionRegistry {
    const registry = new PermissionRegistry();
    registry.register(
      definePermissionGroup({
        name: "invoice_reader",
        label: "Invoice Reader",
        grant: { invoice: { data: { read: "all" } } },
      }),
    );
    // A group that exists but grants the WRONG entity, to prove default-deny.
    registry.register(
      definePermissionGroup({
        name: "order_reader",
        label: "Order Reader",
        grant: { order: { data: { read: "all" } } },
      }),
    );
    return registry;
  }

  it("authorizes onchange when the actor can READ the entity (grant.invoice.data.read)", async () => {
    const middleware = createPermissionMiddleware({ registry: registryWithInvoiceRead() });
    const ctx = onchangeCtx({ type: "human", id: "reader_1", groups: ["invoice_reader"] });
    let nextCalled = false;

    await middleware(ctx, async () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
  });

  it("denies onchange when the actor has no read access to the entity", async () => {
    const middleware = createPermissionMiddleware({ registry: registryWithInvoiceRead() });
    // Has read on `order`, NOT `invoice` → default-deny for the invoice onchange.
    const ctx = onchangeCtx({ type: "human", id: "reader_2", groups: ["order_reader"] });

    await expect(middleware(ctx, async () => {})).rejects.toThrow(AuthorizationError);
  });

  it("denies onchange when an explicit data.read: none shadows an allow (deny wins)", async () => {
    const registry = new PermissionRegistry();
    registry.register(
      definePermissionGroup({
        name: "invoice_reader",
        grant: { invoice: { data: { read: "all" } } },
      }),
    );
    registry.register(
      definePermissionGroup({
        name: "invoice_blocked",
        grant: { invoice: { data: { read: "none" } } },
      }),
    );
    const middleware = createPermissionMiddleware({ registry });
    const ctx = onchangeCtx({
      type: "human",
      id: "reader_3",
      groups: ["invoice_reader", "invoice_blocked"],
    });

    await expect(middleware(ctx, async () => {})).rejects.toThrow(AuthorizationError);
  });

  it("ignores a stray meta.onchange on a real ACTION dispatch (target stays the action)", async () => {
    // Defensive: the read-target branch is scoped to non-action dispatches. A real
    // action carrying meta.onchange must still authorize against its action target.
    const registry = createTestRegistry();
    const middleware = createPermissionMiddleware({ registry });
    const ctx = createTestContext({
      meta: { onchange: { entity: "invoice", changedField: "amount" } },
    });
    let nextCalled = false;

    await middleware(ctx, async () => {
      nextCalled = true;
    });

    // `editors` grants the `submit_request` ACTION target — the onchange meta was
    // ignored because `ctx.action` is present.
    expect(nextCalled).toBe(true);
  });
});

/**
 * Meta-target permission resolution — `meta.aiObservability` (Spec 69 P3 wave 2).
 *
 * The AI trace read route (`GET /api/ai/traces`) dispatches with
 * `skipActionSlots: true`, NO `ctx.action`, and publishes
 * `meta.aiObservability = { operation }`. The middleware should derive an ACTION
 * grant target (`grant.ai.actions.<operation>`) — companion to `meta.evolution`.
 * These tests pin that: a natural grant authorizes, a missing grant denies, the
 * synthetic command name alone never authorizes, and a stray meta on a real action
 * dispatch is ignored.
 */
describe("permission middleware — meta.aiObservability target (skipActionSlots dispatch)", () => {
  /** A trace-read-shaped dispatch: synthetic command, no action, meta target. */
  function readTracesCtx(actor: CommandContext["actor"]): CommandContext {
    return {
      command: "ai.read_traces",
      input: {},
      channel: "http",
      actor,
      meta: { aiObservability: { operation: "read_traces" } },
      // No `action` — non-action dispatch (skipActionSlots).
    } as CommandContext;
  }

  function registryWithAiReadGrant(): PermissionRegistry {
    const registry = new PermissionRegistry();
    registry.register(
      definePermissionGroup({
        name: "ai_observer",
        label: "AI Observer",
        // The NATURAL grant shape a human would author for the read-traces target.
        grant: { ai: { actions: { read_traces: true } } },
      }),
    );
    return registry;
  }

  it("authorizes read-traces via grant.ai.actions.read_traces (the documented target)", async () => {
    const middleware = createPermissionMiddleware({ registry: registryWithAiReadGrant() });
    const ctx = readTracesCtx({ type: "human", id: "obs_1", groups: ["ai_observer"] });
    let nextCalled = false;

    await middleware(ctx, async () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
  });

  it("denies read-traces when the actor's groups grant no ai observability target", async () => {
    const middleware = createPermissionMiddleware({ registry: registryWithAiReadGrant() });
    const ctx = readTracesCtx({ type: "human", id: "stranger", groups: ["some_unrelated_group"] });

    await expect(middleware(ctx, async () => {})).rejects.toThrow(AuthorizationError);
  });

  it("denies read-traces when only the synthetic command name was granted (regression)", async () => {
    // The target is the meta operation, NOT the synthetic command name. Granting
    // the command name must not authorize — guards against command-name gating.
    const registry = new PermissionRegistry();
    registry.register(
      definePermissionGroup({
        name: "command_name_only",
        label: "Command-name grant (wrong shape)",
        grant: { "ai.read_traces": { actions: { "ai.read_traces": true } } },
      }),
    );
    const middleware = createPermissionMiddleware({ registry });
    const ctx = readTracesCtx({ type: "human", id: "obs_2", groups: ["command_name_only"] });

    await expect(middleware(ctx, async () => {})).rejects.toThrow(AuthorizationError);
  });

  it("ignores a stray meta.aiObservability on a real ACTION dispatch (target stays the action)", async () => {
    // Defensive: meta-target resolution is scoped to non-action dispatches. A real
    // action carrying meta.aiObservability must still authorize against its action target.
    const registry = createTestRegistry();
    const middleware = createPermissionMiddleware({ registry });
    const ctx = createTestContext({
      meta: { aiObservability: { operation: "read_traces" } },
    });
    let nextCalled = false;

    await middleware(ctx, async () => {
      nextCalled = true;
    });

    // `editors` grants the `submit_request` ACTION target — the ai meta was ignored
    // because `ctx.action` is present.
    expect(nextCalled).toBe(true);
  });
});
