/**
 * Onchange evaluator — lookup/query/permission error sanitation (Finding 4).
 *
 * Split out of onchange-evaluator-errors.test.ts to keep each file under the
 * 500-line cap (see CodeRabbit review of PR #198 / issue #192). The errors
 * file retains the baseline failure block and the Finding 3 timeout-mutation
 * block; this file owns the lookup/query/permission error-surfacing tests.
 *
 *   - Finding 4: raw internal error messages must not leak into the
 *     client-visible warnings array; they must go through `Logger.warn`.
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
