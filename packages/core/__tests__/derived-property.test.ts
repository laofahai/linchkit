/**
 * Tests for Derived Property Engine (spec 48)
 */

import { describe, expect, test } from "bun:test";
import {
  createDerivedPropertyEngine,
  type DerivedConfig,
  evaluateExpression,
  getDerivedStrategy,
  isDerivedField,
  resolveDerivedValue,
} from "../src/entity/derived-property";
import { buildTableColumns } from "../src/entity/entity-to-drizzle";
import { generateZodSchema } from "../src/entity/entity-to-zod";
import type { EntityDefinition } from "../src/types/entity";

// ── evaluateExpression ────────────────────────────────────────

describe("evaluateExpression", () => {
  test("basic arithmetic", () => {
    expect(evaluateExpression("2 + 3", {})).toBe(5);
    expect(evaluateExpression("10 - 4", {})).toBe(6);
    expect(evaluateExpression("3 * 7", {})).toBe(21);
    expect(evaluateExpression("20 / 4", {})).toBe(5);
    expect(evaluateExpression("10 % 3", {})).toBe(1);
  });

  test("operator precedence", () => {
    expect(evaluateExpression("2 + 3 * 4", {})).toBe(14);
    expect(evaluateExpression("(2 + 3) * 4", {})).toBe(20);
    expect(evaluateExpression("10 - 2 * 3", {})).toBe(4);
  });

  test("field references", () => {
    const record = { amount: 100, quantity: 5 };
    expect(evaluateExpression("amount * quantity", record)).toBe(500);
  });

  test("mixed fields and literals", () => {
    const record = { price: 50, tax_rate: 0.1 };
    expect(evaluateExpression("price * (1 + tax_rate)", record)).toBeCloseTo(55);
  });

  test("missing fields resolve to 0", () => {
    expect(evaluateExpression("missing_field + 10", {})).toBe(10);
  });

  test("comparison operators", () => {
    const record = { a: 10, b: 5 };
    expect(evaluateExpression("a > b", record)).toBe(1);
    expect(evaluateExpression("a < b", record)).toBe(0);
    expect(evaluateExpression("a >= 10", record)).toBe(1);
    expect(evaluateExpression("a == 10", record)).toBe(1);
    expect(evaluateExpression("a != b", record)).toBe(1);
  });

  test("logical operators", () => {
    const record = { a: 1, b: 0 };
    expect(evaluateExpression("a && b", record)).toBe(0);
    expect(evaluateExpression("a || b", record)).toBe(1);
    expect(evaluateExpression("!a", record)).toBe(0);
    expect(evaluateExpression("!b", record)).toBe(1);
  });

  test("ternary operator", () => {
    const record = { status: 1, value: 42 };
    expect(evaluateExpression("status ? value : 0", record)).toBe(42);
    expect(evaluateExpression("0 ? value : 99", record)).toBe(99);
  });

  test("unary minus", () => {
    expect(evaluateExpression("-5 + 10", {})).toBe(5);
    expect(evaluateExpression("-(3 + 2)", {})).toBe(-5);
  });

  test("division by zero returns 0", () => {
    expect(evaluateExpression("10 / 0", {})).toBe(0);
    expect(evaluateExpression("10 % 0", {})).toBe(0);
  });

  test("boolean field values", () => {
    const record = { is_active: true, is_deleted: false };
    expect(evaluateExpression("is_active", record)).toBe(1);
    expect(evaluateExpression("is_deleted", record)).toBe(0);
  });

  test("empty expression returns 0", () => {
    expect(evaluateExpression("", {})).toBe(0);
  });

  test("decimal numbers", () => {
    expect(evaluateExpression("3.14 * 2", {})).toBeCloseTo(6.28);
    expect(evaluateExpression("0.1 + 0.2", {})).toBeCloseTo(0.3);
  });

  test("nested parentheses", () => {
    expect(evaluateExpression("((2 + 3) * (4 - 1))", {})).toBe(15);
  });

  test("invalid character throws", () => {
    expect(() => evaluateExpression("2 @ 3", {})).toThrow("Unexpected character");
  });
});

// ── resolveDerivedValue ───────────────────────────────────────

describe("resolveDerivedValue", () => {
  test("expression type", () => {
    const derived: DerivedConfig = {
      type: "expression",
      expr: "price * quantity",
    };
    const record = { price: 25, quantity: 4 };
    expect(resolveDerivedValue(derived, record)).toBe(100);
  });

  test("concat type with separator", () => {
    const derived: DerivedConfig = {
      type: "concat",
      fields: ["last_name", "first_name"],
      separator: " ",
    };
    const record = { last_name: "Zhang", first_name: "San" };
    expect(resolveDerivedValue(derived, record)).toBe("Zhang San");
  });

  test("concat type without separator", () => {
    const derived: DerivedConfig = {
      type: "concat",
      fields: ["prefix", "code"],
    };
    const record = { prefix: "PO", code: "2026001" };
    expect(resolveDerivedValue(derived, record)).toBe("PO2026001");
  });

  test("concat skips null/undefined/empty values", () => {
    const derived: DerivedConfig = {
      type: "concat",
      fields: ["a", "b", "c"],
      separator: "-",
    };
    const record = { a: "hello", b: null, c: "world" };
    expect(resolveDerivedValue(derived, record)).toBe("hello-world");
  });

  test("function type", () => {
    const derived: DerivedConfig = {
      type: "function",
      compute: (rec) => {
        const due = rec.due_date as string;
        if (!due) return 0;
        const dueTime = new Date(due).getTime();
        const now = new Date("2026-03-25").getTime();
        return Math.max(0, Math.floor((now - dueTime) / (1000 * 60 * 60 * 24)));
      },
      deps: ["due_date"],
    };
    const record = { due_date: "2026-03-20" };
    expect(resolveDerivedValue(derived, record)).toBe(5);
  });

  test("aggregate type returns undefined (stub)", () => {
    const derived: DerivedConfig = {
      type: "aggregate",
      source: { link: "order_to_items", schema: "order_item" },
      op: "sum",
      field: "amount",
    };
    expect(resolveDerivedValue(derived, {})).toBeUndefined();
  });
});

// ── DerivedPropertyEngine ─────────────────────────────────────

describe("DerivedPropertyEngine", () => {
  function makeSchema(overrides?: Partial<EntityDefinition>): EntityDefinition {
    return {
      name: "order",
      fields: {
        price: { type: "number" },
        quantity: { type: "number" },
        total: {
          type: "number",
          derived: {
            type: "expression",
            expr: "price * quantity",
            strategy: "store",
            deps: ["price", "quantity"],
          },
        },
        display_name: {
          type: "string",
          derived: {
            type: "concat",
            fields: ["prefix", "code"],
            separator: "-",
            strategy: "compute",
          },
        },
        prefix: { type: "string" },
        code: { type: "string" },
      },
      ...overrides,
    };
  }

  test("register and getDerivedFields", () => {
    const engine = createDerivedPropertyEngine();
    engine.register([makeSchema()]);

    const fields = engine.getDerivedFields("order");
    expect(fields).toHaveLength(2);
    expect(fields.map((f) => f.fieldName).sort()).toEqual(["display_name", "total"]);
  });

  test("getStoreFields and getComputeFields", () => {
    const engine = createDerivedPropertyEngine();
    engine.register([makeSchema()]);

    expect(engine.getStoreFields("order")).toHaveLength(1);
    expect(engine.getStoreFields("order")[0].fieldName).toBe("total");

    expect(engine.getComputeFields("order")).toHaveLength(1);
    expect(engine.getComputeFields("order")[0].fieldName).toBe("display_name");
  });

  test("isDerived", () => {
    const engine = createDerivedPropertyEngine();
    engine.register([makeSchema()]);

    expect(engine.isDerived("order", "total")).toBe(true);
    expect(engine.isDerived("order", "price")).toBe(false);
    expect(engine.isDerived("order", "display_name")).toBe(true);
  });

  test("resolveComputeFields", () => {
    const engine = createDerivedPropertyEngine();
    engine.register([makeSchema()]);

    const record: Record<string, unknown> = { prefix: "PO", code: "001" };
    engine.resolveComputeFields("order", record);
    expect(record.display_name).toBe("PO-001");
  });

  test("computeStoreFields", () => {
    const engine = createDerivedPropertyEngine();
    engine.register([makeSchema()]);

    const record = { price: 10, quantity: 5 };
    const storeValues = engine.computeStoreFields("order", record);
    expect(storeValues.total).toBe(50);
    // compute-strategy fields should NOT be in store values
    expect(storeValues.display_name).toBeUndefined();
  });

  test("circular dependency detection", () => {
    const schema: EntityDefinition = {
      name: "circular",
      fields: {
        a: {
          type: "number",
          derived: {
            type: "expression",
            expr: "b + 1",
            strategy: "store",
            deps: ["b"],
          },
        },
        b: {
          type: "number",
          derived: {
            type: "expression",
            expr: "a + 1",
            strategy: "store",
            deps: ["a"],
          },
        },
      },
    };

    const engine = createDerivedPropertyEngine();
    expect(() => engine.register([schema])).toThrow("Circular dependency");
  });

  test("topological ordering — chained derived fields", () => {
    const schema: EntityDefinition = {
      name: "invoice",
      fields: {
        price: { type: "number" },
        quantity: { type: "number" },
        subtotal: {
          type: "number",
          derived: {
            type: "expression",
            expr: "price * quantity",
            strategy: "store",
            deps: ["price", "quantity"],
          },
        },
        tax: {
          type: "number",
          derived: {
            type: "expression",
            expr: "subtotal * 0.1",
            strategy: "store",
            deps: ["subtotal"],
          },
        },
        total: {
          type: "number",
          derived: {
            type: "expression",
            expr: "subtotal + tax",
            strategy: "store",
            deps: ["subtotal", "tax"],
          },
        },
      },
    };

    const engine = createDerivedPropertyEngine();
    engine.register([schema]);

    const record = { price: 100, quantity: 2 };
    const storeValues = engine.computeStoreFields("invoice", record);
    expect(storeValues.subtotal).toBe(200);
    expect(storeValues.tax).toBeCloseTo(20);
    expect(storeValues.total).toBeCloseTo(220);
  });

  test("function derived in compute strategy", () => {
    const schema: EntityDefinition = {
      name: "task",
      fields: {
        status: { type: "string" },
        priority: { type: "number" },
        urgency_label: {
          type: "string",
          derived: {
            type: "function",
            compute: (rec) => {
              const p = rec.priority as number;
              if (p >= 8) return "critical";
              if (p >= 5) return "high";
              return "normal";
            },
            strategy: "compute",
            deps: ["priority"],
          },
        },
      },
    };

    const engine = createDerivedPropertyEngine();
    engine.register([schema]);

    const record: Record<string, unknown> = { status: "open", priority: 9 };
    engine.resolveComputeFields("task", record);
    expect(record.urgency_label).toBe("critical");
  });

  test("multiple schemas", () => {
    const schemas: EntityDefinition[] = [
      {
        name: "product",
        fields: {
          price: { type: "number" },
          cost: { type: "number" },
          margin: {
            type: "number",
            derived: {
              type: "expression",
              expr: "price - cost",
              strategy: "store",
              deps: ["price", "cost"],
            },
          },
        },
      },
      {
        name: "employee",
        fields: {
          first_name: { type: "string" },
          last_name: { type: "string" },
          full_name: {
            type: "string",
            derived: {
              type: "concat",
              fields: ["first_name", "last_name"],
              separator: " ",
              strategy: "compute",
            },
          },
        },
      },
    ];

    const engine = createDerivedPropertyEngine();
    engine.register(schemas);

    expect(engine.getDerivedFields("product")).toHaveLength(1);
    expect(engine.getDerivedFields("employee")).toHaveLength(1);

    const productStore = engine.computeStoreFields("product", { price: 100, cost: 60 });
    expect(productStore.margin).toBe(40);

    const empRecord: Record<string, unknown> = { first_name: "Jane", last_name: "Doe" };
    engine.resolveComputeFields("employee", empRecord);
    expect(empRecord.full_name).toBe("Jane Doe");
  });

  test("default strategy is store", () => {
    const schema: EntityDefinition = {
      name: "test",
      fields: {
        a: { type: "number" },
        b: {
          type: "number",
          derived: {
            type: "expression",
            expr: "a * 2",
            // No explicit strategy — should default to "store"
          },
        },
      },
    };

    const engine = createDerivedPropertyEngine();
    engine.register([schema]);

    const info = engine.getFieldInfo("test", "b");
    expect(info?.strategy).toBe("store");
    expect(engine.getStoreFields("test")).toHaveLength(1);
  });
});

// ── Integration: Zod schema skips derived fields ──────────────

describe("Zod schema excludes derived fields", () => {
  test("derived fields not in Zod schema shape", () => {
    const schema: EntityDefinition = {
      name: "order",
      fields: {
        price: { type: "number" },
        quantity: { type: "number" },
        total: {
          type: "number",
          derived: {
            type: "expression",
            expr: "price * quantity",
            strategy: "store",
          },
        },
      },
    };

    const zod = generateZodSchema(schema);
    const shape = zod.shape;

    // price and quantity should be in the shape
    expect(shape.price).toBeDefined();
    expect(shape.quantity).toBeDefined();
    // total is derived — should NOT be in input schema
    expect(shape.total).toBeUndefined();
  });
});

// ── Integration: Drizzle skips compute-strategy derived fields ──

describe("Drizzle column generation for derived fields", () => {
  test("store-strategy derived fields get DB columns", () => {
    const schema: EntityDefinition = {
      name: "order",
      fields: {
        price: { type: "number" },
        total: {
          type: "number",
          derived: {
            type: "expression",
            expr: "price * 2",
            strategy: "store",
          },
        },
      },
    };

    const columns = buildTableColumns(schema);
    expect(columns.price).toBeDefined();
    expect(columns.total).toBeDefined(); // store strategy → column exists
  });

  test("compute-strategy derived fields do NOT get DB columns", () => {
    const schema: EntityDefinition = {
      name: "order",
      fields: {
        price: { type: "number" },
        computed_label: {
          type: "string",
          derived: {
            type: "concat",
            fields: ["prefix"],
            strategy: "compute",
          },
        },
      },
    };

    const columns = buildTableColumns(schema);
    expect(columns.price).toBeDefined();
    expect(columns.computed_label).toBeUndefined(); // compute strategy → no column
  });
});

// ── Helper functions ──────────────────────────────────────────

describe("isDerivedField and getDerivedStrategy", () => {
  test("isDerivedField returns true for derived fields", () => {
    expect(isDerivedField({ type: "number", derived: { type: "expression", expr: "a + b" } })).toBe(
      true,
    );
    expect(isDerivedField({ type: "number" })).toBe(false);
  });

  test("getDerivedStrategy defaults to store", () => {
    expect(getDerivedStrategy({ type: "number", derived: { type: "expression", expr: "a" } })).toBe(
      "store",
    );
    expect(
      getDerivedStrategy({
        type: "number",
        derived: { type: "expression", expr: "a", strategy: "compute" },
      }),
    ).toBe("compute");
    expect(
      getDerivedStrategy({
        type: "number",
        derived: { type: "expression", expr: "a", strategy: "store" },
      }),
    ).toBe("store");
  });
});
