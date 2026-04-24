/**
 * Onchange evaluator — `checkReadPermission` integration (Spec 64 §4.3).
 *
 * Covers:
 *   - lookup/query gated by the caller-supplied permission check
 *   - warning dedup across repeated denials within a single hook
 *   - warning dedup across chained hooks that all deny on the same entity
 */

import { describe, expect, test } from "bun:test";
import { createOnchangeEvaluator } from "../src/engine/onchange-evaluator";
import type { EntityDefinition } from "../src/types/entity";
import { ACTOR, createStubDataProvider, registerEntity } from "./onchange-evaluator-fixtures";

describe("createOnchangeEvaluator — checkReadPermission", () => {
  test("drops lookup result and emits warning when read is denied", async () => {
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
      checkReadPermission: ({ entity: target }) => target !== "product",
    });

    const result = await evaluator.evaluate({
      entityName: "line",
      changedField: "product_id",
      values: { product_id: "p1" },
      actor: ACTOR,
    });
    // Lookup was denied; the hook still ran but received `undefined` from lookup,
    // so unit_price ends up as undefined after filterByAllowlist.
    expect(result.updates).toEqual({ unit_price: undefined });
    expect(result.warnings.some((w) => w.includes('Access to "product" denied'))).toBe(true);
  });

  test("allows data access when checkReadPermission returns true", async () => {
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
      checkReadPermission: () => true,
    });

    const result = await evaluator.evaluate({
      entityName: "line",
      changedField: "product_id",
      values: { product_id: "p1" },
      actor: ACTOR,
    });
    expect(result.updates).toEqual({ unit_price: 42 });
    expect(result.warnings).toEqual([]);
  });

  test("collapses repeated denials of the same entity into a single warning", async () => {
    const entity: EntityDefinition = {
      name: "line",
      fields: {
        a: { type: "string" },
        b: { type: "string" },
      },
      onchange: {
        a: {
          updates: ["b"],
          compute: async (ctx) => {
            // Two consecutive denied lookups should produce only ONE warning
            // about `product`.
            await ctx.lookup("product", "x", "price");
            await ctx.lookup("product", "y", "price");
            const list = await ctx.query("product", { kind: "widget" });
            return { b: `${list.length}` };
          },
        },
      },
    };
    const evaluator = createOnchangeEvaluator({
      entityRegistry: registerEntity(entity),
      dataProvider: createStubDataProvider({
        records: { product: { x: { id: "x", price: 1 } } },
      }),
      checkReadPermission: () => false,
    });

    const result = await evaluator.evaluate({
      entityName: "line",
      changedField: "a",
      values: { a: "v" },
      actor: ACTOR,
    });
    expect(result.updates).toEqual({ b: "0" });
    const denials = result.warnings.filter((w) => w.includes('Access to "product" denied'));
    expect(denials.length).toBe(1);
  });

  // E2-2 regression: warnings from `checkReadPermission` must dedup across
  // chained hooks, not just within a single hook invocation.
  test("collapses repeated denials across chained hooks into a single warning", async () => {
    const entity: EntityDefinition = {
      name: "chain",
      fields: {
        a: { type: "string" },
        b: { type: "string" },
        c: { type: "string" },
      },
      onchange: {
        // Hook A triggers and produces `b`, which then triggers hook B.
        // Both hooks try to lookup on `product` and both are denied.
        a: {
          updates: ["b"],
          compute: async (ctx) => {
            await ctx.lookup("product", "x", "price");
            return { b: "from-a" };
          },
        },
        b: {
          updates: ["c"],
          compute: async (ctx) => {
            await ctx.lookup("product", "y", "price");
            return { c: "from-b" };
          },
        },
      },
    };
    const evaluator = createOnchangeEvaluator({
      entityRegistry: registerEntity(entity),
      dataProvider: createStubDataProvider({
        records: { product: { x: { id: "x", price: 1 } } },
      }),
      checkReadPermission: () => false,
    });

    const result = await evaluator.evaluate({
      entityName: "chain",
      changedField: "a",
      values: { a: "v" },
      actor: ACTOR,
    });
    expect(result.updates).toEqual({ b: "from-a", c: "from-b" });
    const denials = result.warnings.filter((w) => w.includes('Access to "product" denied'));
    expect(denials.length).toBe(1);
  });
});
