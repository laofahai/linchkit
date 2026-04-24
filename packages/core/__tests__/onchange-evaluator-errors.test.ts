/**
 * Onchange evaluator — baseline failures + Finding 3 timeout mutation safety.
 *
 * This file owns the baseline failure tests and the timeout-mutation
 * regression tests from the CodeRabbit review of PR #191 (issue #192 /
 * Spec 64 Phase 1):
 *
 *   - Finding 3: timed-out hooks must not mutate shared evaluation state
 *     (late updates dropped, revocable sink suppresses late warnings).
 *
 * Related splits:
 *   - onchange-evaluator-sanitation.test.ts — Finding 4 lookup/query error
 *     sanitation and permission-check surfacing.
 *   - onchange-evaluator-mutation.test.ts   — Finding 5 clone-boundary checks.
 */

import { describe, expect, test } from "bun:test";
import { createOnchangeEvaluator } from "../src/engine/onchange-evaluator";
import type { EntityDefinition } from "../src/types/entity";
import {
  ACTOR,
  createFailingDataProvider,
  createSpyLogger,
  createStubDataProvider,
  registerEntity,
} from "./onchange-evaluator-fixtures";

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

// Lookup/query/permission error-sanitation tests live in
// onchange-evaluator-sanitation.test.ts.
// Mutation-safety tests live in onchange-evaluator-mutation.test.ts.
