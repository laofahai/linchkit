/**
 * Onchange evaluator — error surfacing, timeouts, warning sanitation, and
 * mutation safety.
 *
 * This file owns the regression tests for the CodeRabbit review of PR #191
 * (issue #192 / Spec 64 Phase 1):
 *
 *   - Finding 3: timed-out hooks must not mutate shared evaluation state.
 *   - Finding 4: raw internal error messages must not leak into the
 *     client-visible warnings array; they must go through `Logger.warn`.
 *   - Finding 5: `ctx.values` / `lookup` / `query` results are handed to
 *     hooks via a defensive clone so a misbehaving hook cannot mutate the
 *     shared accumulator seen by subsequent hooks.
 */

import { describe, expect, test } from "bun:test";
import { createOnchangeEvaluator } from "../src/engine/onchange-evaluator";
import type { EntityDefinition } from "../src/types/entity";
import type { Logger } from "../src/types/logger";
import {
  ACTOR,
  createFailingDataProvider,
  createStubDataProvider,
  registerEntity,
} from "./onchange-evaluator-fixtures";

// ── Logger spy helper ──────────────────────────────────────

interface LoggerCall {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  context?: Record<string, unknown>;
}

function createSpyLogger(): { logger: Logger; calls: LoggerCall[] } {
  const calls: LoggerCall[] = [];
  const make =
    (level: LoggerCall["level"]) => (message: string, context?: Record<string, unknown>) => {
      calls.push({ level, message, context });
    };
  return {
    calls,
    logger: {
      debug: make("debug"),
      info: make("info"),
      warn: make("warn"),
      error: make("error"),
    },
  };
}

// ── Baseline error handling ────────────────────────────────

describe("createOnchangeEvaluator — failures", () => {
  test("captures thrown errors into sanitized warnings, does not propagate", async () => {
    const entity: EntityDefinition = {
      name: "line",
      fields: {
        product_id: { type: "string" },
        unit_price: { type: "number" },
      },
      onchange: {
        product_id: {
          updates: ["unit_price"],
          compute: () => {
            throw new Error("boom");
          },
        },
      },
    };
    const { logger, calls } = createSpyLogger();
    const evaluator = createOnchangeEvaluator({
      entityRegistry: registerEntity(entity),
      dataProvider: createStubDataProvider(),
      logger,
    });

    const result = await evaluator.evaluate({
      entityName: "line",
      changedField: "product_id",
      values: { product_id: "p1" },
      actor: ACTOR,
    });
    expect(result.updates).toEqual({});
    // Finding 4 — user-facing warning must NOT include the raw "boom" detail.
    const warning = result.warnings.find((w) => w.includes("threw an error"));
    expect(warning).toBeDefined();
    expect(warning).not.toContain("boom");
    // …but the real message must reach the server log.
    const loggedHookThrow = calls.find(
      (c) => c.level === "warn" && c.message === "onchange: hook threw",
    );
    expect(loggedHookThrow).toBeDefined();
    expect(loggedHookThrow?.context?.error).toBe("boom");
  });

  test("per-hook timeout resolves with warning and empty updates", async () => {
    const entity: EntityDefinition = {
      name: "line",
      fields: {
        product_id: { type: "string" },
        unit_price: { type: "number" },
      },
      onchange: {
        product_id: {
          updates: ["unit_price"],
          timeout: 20,
          compute: () =>
            new Promise((resolve) => {
              setTimeout(() => resolve({ unit_price: 99 }), 200);
            }),
        },
      },
    };
    const evaluator = createOnchangeEvaluator({
      entityRegistry: registerEntity(entity),
      dataProvider: createStubDataProvider(),
    });

    const result = await evaluator.evaluate({
      entityName: "line",
      changedField: "product_id",
      values: { product_id: "p1" },
      actor: ACTOR,
    });
    expect(result.updates).toEqual({});
    expect(result.warnings.some((w) => w.includes("timeout"))).toBe(true);
  });
});

// ── Finding 3: timeout mutation safety ─────────────────────

describe("createOnchangeEvaluator — timeout mutation safety (Finding 3)", () => {
  test("late-arriving hook updates after timeout are NOT reflected in the final result", async () => {
    // The hook resolves AFTER the timeout has fired. Before Finding 3 it would
    // race into `filterByAllowlist` / the accumulator; now the `timedOut` guard
    // drops the late result silently.
    const entity: EntityDefinition = {
      name: "line",
      fields: {
        product_id: { type: "string" },
        unit_price: { type: "number" },
        description: { type: "string" },
      },
      onchange: {
        product_id: {
          updates: ["unit_price", "description"],
          timeout: 20,
          compute: () =>
            new Promise((resolve) => {
              setTimeout(() => {
                resolve({
                  updates: {
                    unit_price: 99,
                    description: "late write — must be dropped",
                  },
                  warnings: ["late warning that should not appear"],
                });
              }, 120);
            }),
        },
      },
    };
    const evaluator = createOnchangeEvaluator({
      entityRegistry: registerEntity(entity),
      dataProvider: createStubDataProvider(),
    });

    const result = await evaluator.evaluate({
      entityName: "line",
      changedField: "product_id",
      values: { product_id: "p1" },
      actor: ACTOR,
    });

    // Only the timeout warning — NO late unit_price, NO late description,
    // NO late hook warning.
    expect(result.updates).toEqual({});
    expect(result.warnings.some((w) => w.includes("timeout"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("late warning"))).toBe(false);

    // Give the background promise time to settle so the test process doesn't
    // report dangling work. The accumulator is already frozen at this point.
    await new Promise((r) => setTimeout(r, 150));
    expect(result.updates).toEqual({});
  });

  test("hook that never resolves still times out without wedging the evaluator", async () => {
    const entity: EntityDefinition = {
      name: "line",
      fields: {
        product_id: { type: "string" },
        unit_price: { type: "number" },
      },
      onchange: {
        product_id: {
          updates: ["unit_price"],
          timeout: 20,
          compute: () => new Promise<never>(() => {}),
        },
      },
    };
    const evaluator = createOnchangeEvaluator({
      entityRegistry: registerEntity(entity),
      dataProvider: createStubDataProvider(),
    });

    const result = await evaluator.evaluate({
      entityName: "line",
      changedField: "product_id",
      values: { product_id: "p1" },
      actor: ACTOR,
    });
    expect(result.updates).toEqual({});
    expect(result.warnings.some((w) => w.includes("timeout"))).toBe(true);
  });

  test("Blocker 2 — timeout path emits logger.warn with full context", async () => {
    const entity: EntityDefinition = {
      name: "line",
      fields: {
        product_id: { type: "string" },
        unit_price: { type: "number" },
      },
      onchange: {
        product_id: {
          updates: ["unit_price"],
          timeout: 20,
          compute: () => new Promise<never>(() => {}),
        },
      },
    };
    const { logger, calls } = createSpyLogger();
    const evaluator = createOnchangeEvaluator({
      entityRegistry: registerEntity(entity),
      dataProvider: createStubDataProvider(),
      logger,
    });

    await evaluator.evaluate({
      entityName: "line",
      changedField: "product_id",
      values: { product_id: "p1" },
      actor: ACTOR,
      tenantId: "tenant-7",
    });

    const loggedTimeout = calls.find(
      (c) => c.level === "warn" && c.message === "onchange: hook timed out",
    );
    expect(loggedTimeout).toBeDefined();
    expect(loggedTimeout?.context?.entity).toBe("line");
    expect(loggedTimeout?.context?.field).toBe("product_id");
    expect(loggedTimeout?.context?.actor).toBe("u1");
    expect(loggedTimeout?.context?.tenantId).toBe("tenant-7");
    expect(loggedTimeout?.context?.timeoutMs).toBe(20);
  });

  test("Blocker 1 — late warnings pushed after timeout are suppressed + logged", async () => {
    // The hook captures `ctx` then triggers an internal ctx.lookup() AFTER the
    // timeout has fired. The lookup's sanitized warning would otherwise reach
    // the client-visible warnings array via the shared sink. With the
    // revocable-sink guard, that push is dropped and re-routed to Logger.warn.
    const entity: EntityDefinition = {
      name: "line",
      fields: {
        product_id: { type: "string" },
        unit_price: { type: "number" },
      },
      onchange: {
        product_id: {
          updates: ["unit_price"],
          timeout: 20,
          compute: (ctx) =>
            new Promise((resolve) => {
              setTimeout(() => {
                // This runs AFTER the evaluator has already resolved the
                // outer `evaluate()` via the timeout race. It exercises the
                // captured sink reference that lives in the lookup closure.
                ctx
                  .lookup("product", "late-id", "price")
                  .then(() => resolve({ unit_price: 99 }))
                  .catch(() => resolve({ unit_price: 99 }));
              }, 120);
            }),
        },
      },
    };
    const { logger, calls } = createSpyLogger();
    const evaluator = createOnchangeEvaluator({
      entityRegistry: registerEntity(entity),
      // Failing provider so the late lookup would emit a sanitized warning
      // into the shared sink — unless the revocable guard is in place.
      dataProvider: createFailingDataProvider("late DB error"),
      logger,
    });

    const result = await evaluator.evaluate({
      entityName: "line",
      changedField: "product_id",
      values: { product_id: "p1" },
      actor: ACTOR,
    });

    // Only the timeout warning survives. No late lookup warning leaked in.
    expect(result.warnings.some((w) => w.includes("timeout"))).toBe(true);

    // Give the background hook promise time to settle and attempt its late
    // push. The revocable sink must swallow it.
    await new Promise((r) => setTimeout(r, 200));

    expect(result.warnings.some((w) => w.includes('lookup on "product" failed'))).toBe(false);
    // The suppressed push is logged at warn level so server-side observability
    // is preserved.
    const suppressed = calls.find(
      (c) =>
        c.level === "warn" && c.message === "onchange: suppressed late warning from timed-out hook",
    );
    expect(suppressed).toBeDefined();
    expect(String(suppressed?.context?.hook)).toContain("product_id");
  });
});

// ── Finding 4: lookup/query error sanitation ───────────────

describe("createOnchangeEvaluator — lookup/query error surfacing", () => {
  test("DataProvider lookup error: sanitized warning, raw detail goes to Logger (Finding 4)", async () => {
    const entity: EntityDefinition = {
      name: "line",
      fields: {
        product_id: { type: "string" },
        unit_price: { type: "number" },
        status: { type: "string" },
      },
      onchange: {
        product_id: {
          updates: ["unit_price", "status"],
          compute: async (ctx) => {
            const price = await ctx.lookup("product", ctx.value as string, "price");
            return {
              unit_price: price,
              status: "ok",
            };
          },
        },
      },
    };
    const { logger, calls } = createSpyLogger();
    const evaluator = createOnchangeEvaluator({
      entityRegistry: registerEntity(entity),
      dataProvider: createFailingDataProvider("SQL error: detail=xyz"),
      logger,
    });

    const result = await evaluator.evaluate({
      entityName: "line",
      changedField: "product_id",
      values: { product_id: "p1" },
      actor: ACTOR,
    });

    expect(result.updates.status).toBe("ok");
    expect(result.updates.unit_price).toBeUndefined();

    // Finding 4 — user-facing warning does NOT contain any internal detail.
    const lookupWarnings = result.warnings.filter((w) => w.includes('lookup on "product" failed'));
    expect(lookupWarnings.length).toBe(1);
    expect(lookupWarnings[0]).not.toContain("SQL error");
    expect(lookupWarnings[0]).not.toContain("detail=xyz");

    // …but the Logger received the real error with full context.
    const loggedLookup = calls.find(
      (c) => c.level === "warn" && c.message === "onchange: lookup failed",
    );
    expect(loggedLookup).toBeDefined();
    expect(loggedLookup?.context?.error).toBe("SQL error: detail=xyz");
    expect(loggedLookup?.context?.entity).toBe("product");
    expect(loggedLookup?.context?.field).toBe("price");
  });

  test("DataProvider query error: sanitized warning, raw detail goes to Logger", async () => {
    const entity: EntityDefinition = {
      name: "line",
      fields: {
        product_id: { type: "string" },
        unit_price: { type: "number" },
      },
      onchange: {
        product_id: {
          updates: ["unit_price"],
          compute: async (ctx) => {
            const list = await ctx.query("product", { kind: "widget" });
            return { unit_price: list.length };
          },
        },
      },
    };
    const { logger, calls } = createSpyLogger();
    const evaluator = createOnchangeEvaluator({
      entityRegistry: registerEntity(entity),
      dataProvider: createFailingDataProvider("connection reset by peer"),
      logger,
    });

    const result = await evaluator.evaluate({
      entityName: "line",
      changedField: "product_id",
      values: { product_id: "p1" },
      actor: ACTOR,
    });
    expect(result.updates.unit_price).toBe(0);

    const queryWarnings = result.warnings.filter((w) => w.includes('query on "product" failed'));
    expect(queryWarnings.length).toBe(1);
    expect(queryWarnings[0]).not.toContain("connection reset");

    const loggedQuery = calls.find(
      (c) => c.level === "warn" && c.message === "onchange: query failed",
    );
    expect(loggedQuery).toBeDefined();
    expect(loggedQuery?.context?.error).toBe("connection reset by peer");
  });

  test("permission-check failure: sanitized warning + Logger entry (Finding 4)", async () => {
    const entity: EntityDefinition = {
      name: "line",
      fields: {
        product_id: { type: "string" },
        unit_price: { type: "number" },
      },
      onchange: {
        product_id: {
          updates: ["unit_price"],
          compute: async (ctx) => ({
            unit_price: await ctx.lookup("product", ctx.value as string, "price"),
          }),
        },
      },
    };
    const { logger, calls } = createSpyLogger();
    const evaluator = createOnchangeEvaluator({
      entityRegistry: registerEntity(entity),
      dataProvider: createStubDataProvider({
        records: { product: { p1: { id: "p1", price: 42 } } },
      }),
      checkReadPermission: () => {
        throw new Error("internal ACL lookup exploded: role=admin");
      },
      logger,
    });

    const result = await evaluator.evaluate({
      entityName: "line",
      changedField: "product_id",
      values: { product_id: "p1" },
      actor: ACTOR,
    });

    const warning = result.warnings.find((w) => w.includes("permission check failed"));
    expect(warning).toBeDefined();
    expect(warning).not.toContain("internal ACL lookup exploded");
    expect(warning).not.toContain("role=admin");

    const loggedPerm = calls.find(
      (c) => c.level === "warn" && c.message === "onchange: read-permission check failed",
    );
    expect(loggedPerm).toBeDefined();
    expect(loggedPerm?.context?.error).toContain("internal ACL lookup exploded");
  });

  test("permission denial stays as a permission-warning (not a lookup-warning)", async () => {
    const entity: EntityDefinition = {
      name: "line",
      fields: {
        product_id: { type: "string" },
        unit_price: { type: "number" },
      },
      onchange: {
        product_id: {
          updates: ["unit_price"],
          compute: async (ctx) => ({
            unit_price: await ctx.lookup("product", ctx.value as string, "price"),
          }),
        },
      },
    };
    const evaluator = createOnchangeEvaluator({
      entityRegistry: registerEntity(entity),
      dataProvider: createStubDataProvider({
        records: { product: { p1: { id: "p1", price: 42 } } },
      }),
      checkReadPermission: () => false,
    });

    const result = await evaluator.evaluate({
      entityName: "line",
      changedField: "product_id",
      values: { product_id: "p1" },
      actor: ACTOR,
    });
    // Permission path is taken (not the try/catch fallback) — so we see the
    // access-denied warning and NOT a lookup-failed warning.
    expect(result.warnings.some((w) => w.includes('Access to "product" denied'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('lookup on "product" failed'))).toBe(false);
  });

  test("collapses repeated identical lookup errors across chained hooks", async () => {
    const entity: EntityDefinition = {
      name: "chain",
      fields: {
        a: { type: "string" },
        b: { type: "string" },
        c: { type: "string" },
      },
      onchange: {
        a: {
          updates: ["b"],
          compute: async (ctx) => {
            await ctx.lookup("product", "x", "price");
            return { b: "next" };
          },
        },
        b: {
          updates: ["c"],
          compute: async (ctx) => {
            await ctx.lookup("product", "y", "price");
            return { c: "done" };
          },
        },
      },
    };
    const evaluator = createOnchangeEvaluator({
      entityRegistry: registerEntity(entity),
      dataProvider: createFailingDataProvider("DB connection reset"),
    });

    const result = await evaluator.evaluate({
      entityName: "chain",
      changedField: "a",
      values: { a: "start" },
      actor: ACTOR,
    });
    expect(result.updates).toEqual({ b: "next", c: "done" });
    const lookupWarnings = result.warnings.filter((w) => w.includes('lookup on "product" failed'));
    expect(lookupWarnings.length).toBe(1);
  });
});

// Mutation-safety tests live in onchange-evaluator-mutation.test.ts.
