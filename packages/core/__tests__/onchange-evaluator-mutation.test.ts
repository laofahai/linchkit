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

  test("Blocker 3 — hook mutations to ctx.value and ctx.actor are isolated per hook", async () => {
    // Hook A mutates ctx.value (replaces its shape) AND ctx.actor.groups
    // (adds a forged admin group). Hook B must observe the ORIGINAL actor
    // groups, unmutated. This protects cascaded hooks from actor/permission
    // corruption by a misbehaving earlier hook in the same evaluation.
    const observedByB: { value: unknown; groups: string[] }[] = [];
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
          compute: (ctx) => {
            // Mutate the scalar value's wrapper — if ctx.value were an
            // object reference shared across hooks it would leak. Scalar
            // strings are immutable so we mutate actor.groups instead as
            // the load-bearing assertion.
            (ctx as { value: unknown }).value = "mutated-by-a";
            // Forge admin membership. structuredClone'd actor must prevent
            // this from reaching hook B.
            ctx.actor.groups.push("admin");
            return { b: "from-a" };
          },
        },
        b: {
          updates: ["c"],
          compute: (ctx) => {
            observedByB.push({
              value: ctx.value,
              groups: [...ctx.actor.groups],
            });
            return { c: "from-b" };
          },
        },
      },
    };
    const evaluator = createOnchangeEvaluator({
      entityRegistry: registerEntity(entity),
      dataProvider: createStubDataProvider(),
    });

    const actor = { type: "human" as const, id: "u1", groups: ["user"] };
    const result = await evaluator.evaluate({
      entityName: "chain",
      changedField: "a",
      values: { a: "original-a" },
      actor,
    });

    expect(result.updates).toEqual({ b: "from-a", c: "from-b" });
    // Hook B sees the ORIGINAL actor groups — hook A's forged "admin" did
    // not leak through the cloned actor.
    expect(observedByB).toHaveLength(1);
    expect(observedByB[0]?.groups).toEqual(["user"]);
    // And the caller's actor object is itself untouched — even the cloned
    // copy A mutated stayed inside A's own context.
    expect(actor.groups).toEqual(["user"]);
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
