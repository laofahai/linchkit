/**
 * Onchange evaluator unit tests (Spec 64 §5).
 */

import { describe, expect, test } from "bun:test";
import type { DataProvider } from "../src/engine/action-engine";
import {
  createOnchangeEvaluator,
  MAX_CHAIN_DEPTH,
  OnchangeEvaluatorError,
} from "../src/engine/onchange-evaluator";
import { createEntityRegistry } from "../src/entity/entity-registry";
import type { Actor } from "../src/types/action";
import type { EntityDefinition } from "../src/types/entity";

// ── Fixtures ────────────────────────────────────────────────

const ACTOR: Actor = { type: "human", id: "u1", groups: ["user"] };

/** Minimal in-memory data provider for lookup/query tests. */
function createStubDataProvider(seed?: {
  records?: Record<string, Record<string, Record<string, unknown>>>;
}): DataProvider {
  const store = seed?.records ?? {};
  return {
    async get(entity, id) {
      const rec = store[entity]?.[id];
      if (!rec) throw new Error(`Record ${entity}/${id} not found`);
      return rec;
    },
    async query(entity, filter) {
      const table = store[entity];
      if (!table) return [];
      return Object.values(table).filter((r) =>
        Object.entries(filter).every(([k, v]) => r[k] === v),
      );
    },
    async create() {
      throw new Error("DataProvider.create must not be called from onchange");
    },
    async update() {
      throw new Error("DataProvider.update must not be called from onchange");
    },
    async delete() {
      throw new Error("DataProvider.delete must not be called from onchange");
    },
    async count() {
      throw new Error("not used");
    },
  };
}

function registerEntity(entity: EntityDefinition) {
  const reg = createEntityRegistry();
  reg.register(entity);
  return reg;
}

// ── Tests ───────────────────────────────────────────────────

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

describe("createOnchangeEvaluator — failures", () => {
  test("captures thrown errors into warnings, does not propagate", async () => {
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
    expect(result.warnings.some((w) => w.includes("boom"))).toBe(true);
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

describe("createOnchangeEvaluator — validation errors", () => {
  test("throws ENTITY_NOT_FOUND when entity is unknown", async () => {
    const evaluator = createOnchangeEvaluator({
      entityRegistry: createEntityRegistry(),
      dataProvider: createStubDataProvider(),
    });
    try {
      await evaluator.evaluate({
        entityName: "ghost",
        changedField: "x",
        values: {},
        actor: ACTOR,
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OnchangeEvaluatorError);
      expect((err as OnchangeEvaluatorError).code).toBe("ENTITY_NOT_FOUND");
    }
  });

  test("throws ENTITY_HAS_NO_ONCHANGE when entity has no onchange map", async () => {
    const entity: EntityDefinition = {
      name: "plain",
      fields: { x: { type: "string" } },
    };
    const evaluator = createOnchangeEvaluator({
      entityRegistry: registerEntity(entity),
      dataProvider: createStubDataProvider(),
    });
    try {
      await evaluator.evaluate({
        entityName: "plain",
        changedField: "x",
        values: { x: "v" },
        actor: ACTOR,
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OnchangeEvaluatorError);
      expect((err as OnchangeEvaluatorError).code).toBe("ENTITY_HAS_NO_ONCHANGE");
    }
  });

  test("throws FIELD_UNKNOWN when changedField is not on the entity", async () => {
    const entity: EntityDefinition = {
      name: "line",
      fields: { a: { type: "string" } },
      onchange: {
        a: { updates: [], compute: () => ({}) },
      },
    };
    const evaluator = createOnchangeEvaluator({
      entityRegistry: registerEntity(entity),
      dataProvider: createStubDataProvider(),
    });
    try {
      await evaluator.evaluate({
        entityName: "line",
        changedField: "nope",
        values: {},
        actor: ACTOR,
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OnchangeEvaluatorError);
      expect((err as OnchangeEvaluatorError).code).toBe("FIELD_UNKNOWN");
    }
  });

  test("throws NO_HOOK_FOR_FIELD when field exists on entity but has no onchange hook", async () => {
    // Entity has an onchange map covering `a`, but the caller triggers on `b`.
    // Spec 64 §4.1 says this is a 404 case — the evaluator must surface it as
    // a distinct, typed error so the REST layer maps it to the right status.
    const entity: EntityDefinition = {
      name: "line",
      fields: {
        a: { type: "string" },
        b: { type: "string" },
      },
      onchange: {
        a: { updates: [], compute: () => ({}) },
      },
    };
    const evaluator = createOnchangeEvaluator({
      entityRegistry: registerEntity(entity),
      dataProvider: createStubDataProvider(),
    });
    try {
      await evaluator.evaluate({
        entityName: "line",
        changedField: "b",
        values: { b: "v" },
        actor: ACTOR,
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OnchangeEvaluatorError);
      expect((err as OnchangeEvaluatorError).code).toBe("NO_HOOK_FOR_FIELD");
    }
  });
});

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

// E2-3 regression: lookup / query must never throw from the hook author's
// perspective, but errors swallowed silently are dangerous. Surface them as
// structured warnings instead.
describe("createOnchangeEvaluator — lookup/query error surfacing", () => {
  /** Stub provider whose get/query always throw the same error. */
  function createFailingDataProvider(message: string): DataProvider {
    return {
      async get() {
        throw new Error(message);
      },
      async query() {
        throw new Error(message);
      },
      async create() {
        throw new Error("not used");
      },
      async update() {
        throw new Error("not used");
      },
      async delete() {
        throw new Error("not used");
      },
      async count() {
        throw new Error("not used");
      },
    };
  }

  test("DataProvider error surfaces as a warning but hook still completes", async () => {
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
            // lookup fails, but the hook continues and still returns a value
            // for `status`, proving the rejection did not propagate as a throw.
            const price = await ctx.lookup("product", ctx.value as string, "price");
            return {
              unit_price: price,
              status: "ok",
            };
          },
        },
      },
    };
    const evaluator = createOnchangeEvaluator({
      entityRegistry: registerEntity(entity),
      dataProvider: createFailingDataProvider("DB connection reset"),
    });

    const result = await evaluator.evaluate({
      entityName: "line",
      changedField: "product_id",
      values: { product_id: "p1" },
      actor: ACTOR,
    });
    expect(result.updates.status).toBe("ok");
    expect(result.updates.unit_price).toBeUndefined();
    const lookupWarnings = result.warnings.filter((w) => w.includes('Lookup on "product" failed'));
    expect(lookupWarnings.length).toBe(1);
    expect(lookupWarnings[0]).toContain("DB connection reset");
  });

  test("query error surfaces as a warning and returns []", async () => {
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
    const evaluator = createOnchangeEvaluator({
      entityRegistry: registerEntity(entity),
      dataProvider: createFailingDataProvider("timeout"),
    });

    const result = await evaluator.evaluate({
      entityName: "line",
      changedField: "product_id",
      values: { product_id: "p1" },
      actor: ACTOR,
    });
    expect(result.updates.unit_price).toBe(0);
    const queryWarnings = result.warnings.filter((w) => w.includes('Query on "product" failed'));
    expect(queryWarnings.length).toBe(1);
    expect(queryWarnings[0]).toContain("timeout");
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
    expect(result.warnings.some((w) => w.includes('Lookup on "product" failed'))).toBe(false);
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
    const lookupWarnings = result.warnings.filter((w) => w.includes('Lookup on "product" failed'));
    expect(lookupWarnings.length).toBe(1);
  });
});
