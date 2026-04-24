/**
 * Onchange evaluator — defensive cloning / mutation safety (Finding 5).
 *
 * Verifies that a misbehaving hook cannot poison another hook's view by
 * mutating `ctx.values` or objects returned from `lookup`/`query`. The
 * evaluator clones these at the evaluator/hook boundary via `structuredClone`.
 */

import { describe, expect, test } from "bun:test";
import { createOnchangeEvaluator } from "../src/engine/onchange-evaluator";
import type { EntityDefinition } from "../src/types/entity";
import { ACTOR, createStubDataProvider, registerEntity } from "./onchange-evaluator-fixtures";

describe("createOnchangeEvaluator — mutation safety (Finding 5)", () => {
  test("a hook that mutates ctx.values does NOT corrupt the next hook's view", async () => {
    const observedByB: unknown[] = [];
    const entity: EntityDefinition = {
      name: "chain",
      fields: {
        a: { type: "string" },
        b: { type: "string" },
        c: { type: "string" },
        foo: { type: "string" },
      },
      onchange: {
        a: {
          updates: ["b"],
          compute: (ctx) => {
            // Evil hook tries to poison the shared values object.
            (ctx.values as Record<string, unknown>).foo = "evil";
            return { b: "from-a" };
          },
        },
        b: {
          updates: ["c"],
          compute: (ctx) => {
            observedByB.push(ctx.values.foo);
            return { c: "from-b" };
          },
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
      values: { a: "v", foo: "original" },
      actor: ACTOR,
    });

    expect(result.updates).toEqual({ b: "from-a", c: "from-b" });
    // Hook B must see the ORIGINAL value of `foo`, unmutated by hook A.
    expect(observedByB).toEqual(["original"]);
  });

  test("a hook that mutates a query result does NOT poison a later hook's query", async () => {
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
            const rows = await ctx.query("widget", {});
            if (rows.length > 0) {
              (rows[0] as Record<string, unknown>).name = "mutated-by-a";
            }
            return { b: "from-a" };
          },
        },
        b: {
          updates: ["c"],
          compute: async (ctx) => {
            const rows = await ctx.query("widget", {});
            return { c: String(rows[0]?.name ?? "") };
          },
        },
      },
    };
    const evaluator = createOnchangeEvaluator({
      entityRegistry: registerEntity(entity),
      dataProvider: createStubDataProvider({
        records: { widget: { w1: { id: "w1", name: "original" } } },
      }),
    });

    const result = await evaluator.evaluate({
      entityName: "chain",
      changedField: "a",
      values: { a: "v" },
      actor: ACTOR,
    });
    // Hook B must read the ORIGINAL widget, not what hook A tried to write.
    expect(result.updates.c).toBe("original");
  });
});
