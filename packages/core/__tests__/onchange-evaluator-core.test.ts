/**
 * Onchange evaluator — core BFS, chaining, cycles, allowlist (Spec 64 §5).
 *
 * See onchange-evaluator-fixtures.ts for the index of split files.
 */

import { describe, expect, test } from "bun:test";
import { createOnchangeEvaluator, MAX_CHAIN_DEPTH } from "../src/engine/onchange-evaluator";
import type { EntityDefinition } from "../src/types/entity";
import { ACTOR, createStubDataProvider, registerEntity } from "./onchange-evaluator-fixtures";

describe("createOnchangeEvaluator — single hook", () => {
  test("evaluates a single-field hook", async () => {
    const entity: EntityDefinition = {
      name: "line",
      fields: {
        product_id: { type: "string" },
        unit_price: { type: "number" },
      },
      onchange: {
        product_id: {
          updates: ["unit_price"],
          compute: () => ({ unit_price: 9.99 }),
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

    expect(result.updates).toEqual({ unit_price: 9.99 });
    expect(result.warnings).toEqual([]);
  });

  test("fires comma-separated multi-trigger hook when either field changes", async () => {
    const entity: EntityDefinition = {
      name: "line",
      fields: {
        quantity: { type: "number" },
        unit_price: { type: "number" },
        subtotal: { type: "number" },
      },
      onchange: {
        "quantity,unit_price": {
          updates: ["subtotal"],
          compute: (ctx) => ({
            subtotal:
              ((ctx.values.quantity as number) ?? 0) * ((ctx.values.unit_price as number) ?? 0),
          }),
        },
      },
    };
    const evaluator = createOnchangeEvaluator({
      entityRegistry: registerEntity(entity),
      dataProvider: createStubDataProvider(),
    });

    const r1 = await evaluator.evaluate({
      entityName: "line",
      changedField: "quantity",
      values: { quantity: 3, unit_price: 2 },
      actor: ACTOR,
    });
    expect(r1.updates).toEqual({ subtotal: 6 });

    const r2 = await evaluator.evaluate({
      entityName: "line",
      changedField: "unit_price",
      values: { quantity: 5, unit_price: 7 },
      actor: ACTOR,
    });
    expect(r2.updates).toEqual({ subtotal: 35 });
  });

  test("runs async compute with DataProvider lookup", async () => {
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
    });

    const result = await evaluator.evaluate({
      entityName: "line",
      changedField: "product_id",
      values: { product_id: "p1" },
      actor: ACTOR,
    });
    expect(result.updates).toEqual({ unit_price: 42 });
  });

  test("returns undefined from lookup when record is missing (no throw)", async () => {
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
            unit_price: await ctx.lookup("product", "missing", "price"),
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
      values: { product_id: "x" },
      actor: ACTOR,
    });
    expect(result.updates).toEqual({ unit_price: undefined });
  });
});

describe("createOnchangeEvaluator — chaining", () => {
  test("cascades A → B → C in BFS order", async () => {
    const entity: EntityDefinition = {
      name: "chain",
      fields: {
        a: { type: "number" },
        b: { type: "number" },
        c: { type: "number" },
      },
      onchange: {
        a: {
          updates: ["b"],
          compute: (ctx) => ({ b: (ctx.value as number) + 1 }),
        },
        b: {
          updates: ["c"],
          compute: (ctx) => ({ c: (ctx.value as number) + 1 }),
        },
      },
    };
    const evaluator = createOnchangeEvaluator({
      entityRegistry: registerEntity(entity),
      dataProvider: createStubDataProvider(),
    });

    const result = await evaluator.evaluate({
      entityName: "chain",
      changedField: "a",
      values: { a: 1 },
      actor: ACTOR,
    });
    expect(result.updates).toEqual({ b: 2, c: 3 });
    expect(result.warnings).toEqual([]);
  });

  test("detects cycles via visited set (A → B → A short-circuits)", async () => {
    const entity: EntityDefinition = {
      name: "cycle",
      fields: {
        a: { type: "number" },
        b: { type: "number" },
      },
      onchange: {
        a: { updates: ["b"], compute: () => ({ b: 10 }) },
        b: { updates: ["a"], compute: () => ({ a: 20 }) },
      },
    };
    const evaluator = createOnchangeEvaluator({
      entityRegistry: registerEntity(entity),
      dataProvider: createStubDataProvider(),
    });

    const result = await evaluator.evaluate({
      entityName: "cycle",
      changedField: "a",
      values: { a: 0 },
      actor: ACTOR,
    });
    // a-hook fires -> b=10; b enqueued; b-hook fires -> a=20; a already visited -> stop.
    expect(result.updates).toEqual({ b: 10, a: 20 });
  });

  test("caps chain depth at MAX_CHAIN_DEPTH with a warning", async () => {
    const fields: Record<string, { type: "number" }> = {};
    const onchange: Record<string, { updates: string[]; compute: () => Record<string, number> }> =
      {};
    // Build 10 fields f0..f9 where f_n updates f_{n+1}.
    for (let i = 0; i < 10; i++) {
      fields[`f${i}`] = { type: "number" };
    }
    for (let i = 0; i < 9; i++) {
      onchange[`f${i}`] = {
        updates: [`f${i + 1}`],
        compute: () => ({ [`f${i + 1}`]: i + 1 }),
      };
    }

    const entity: EntityDefinition = {
      name: "deep",
      fields,
      onchange,
    };
    const evaluator = createOnchangeEvaluator({
      entityRegistry: registerEntity(entity),
      dataProvider: createStubDataProvider(),
    });

    const result = await evaluator.evaluate({
      entityName: "deep",
      changedField: "f0",
      values: { f0: 0 },
      actor: ACTOR,
    });

    // Exactly MAX_CHAIN_DEPTH hook evaluations allowed; so f1..f5 get updated, f6..f9 do not.
    expect(Object.keys(result.updates).length).toBe(MAX_CHAIN_DEPTH);
    expect(result.warnings.some((w) => w.includes("chain depth limit reached"))).toBe(true);
  });
});

describe("createOnchangeEvaluator — allowlist filtering", () => {
  test("drops fields outside the hook's updates list with a warning", async () => {
    const entity: EntityDefinition = {
      name: "line",
      fields: {
        product_id: { type: "string" },
        unit_price: { type: "number" },
        description: { type: "string" },
      },
      onchange: {
        product_id: {
          updates: ["unit_price"],
          // description is NOT in updates — must be filtered out.
          compute: () => ({ unit_price: 5, description: "sneaky" }),
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
    expect(result.updates).toEqual({ unit_price: 5 });
    expect(result.warnings.some((w) => w.includes("description"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("allowlist"))).toBe(true);
  });
});
