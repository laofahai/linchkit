/**
 * Tests for Derived Property Engine: Aggregate computations and cascade updates (spec 48)
 *
 * Covers:
 * - computeAggregate(): SUM, COUNT, AVG, MIN, MAX operations
 * - resolveAggregateValue(): async resolution via data provider + link
 * - DerivedPropertyEngine.wire(): link registry + data provider integration
 * - DerivedPropertyEngine.computeStoreFieldsAsync(): async aggregate store fields
 * - DerivedPropertyEngine.cascadeRecalculate(): cross-schema cascade updates
 * - DerivedPropertyEngine.getCascadeTargets(): cascade target discovery
 * - Aggregate with filter
 * - Chained derived fields depending on aggregates
 */

import { describe, expect, test } from "bun:test";
import { InMemoryStore } from "../src/persistence/in-memory-store";
import {
  type AggregateDerived,
  computeAggregate,
  createDerivedPropertyEngine,
  resolveAggregateValue,
} from "../src/entity/derived-property";
import { createRelationRegistry } from "../src/entity/relation-registry";
import type { RelationDefinition } from "../src/types/relation";
import type { EntityDefinition } from "../src/types/entity";

// ── computeAggregate ──────────────────────────────────────────

describe("computeAggregate", () => {
  const records = [
    { amount: 100, quantity: 2 },
    { amount: 200, quantity: 3 },
    { amount: 50, quantity: 1 },
  ];

  test("sum", () => {
    expect(computeAggregate("sum", "amount", records)).toBe(350);
  });

  test("count", () => {
    expect(computeAggregate("count", undefined, records)).toBe(3);
  });

  test("count ignores field parameter", () => {
    expect(computeAggregate("count", "amount", records)).toBe(3);
  });

  test("avg", () => {
    expect(computeAggregate("avg", "amount", records)).toBeCloseTo(116.67, 1);
  });

  test("min", () => {
    expect(computeAggregate("min", "amount", records)).toBe(50);
  });

  test("max", () => {
    expect(computeAggregate("max", "amount", records)).toBe(200);
  });

  test("empty records returns 0", () => {
    expect(computeAggregate("sum", "amount", [])).toBe(0);
    expect(computeAggregate("count", undefined, [])).toBe(0);
    expect(computeAggregate("avg", "amount", [])).toBe(0);
    expect(computeAggregate("min", "amount", [])).toBe(0);
    expect(computeAggregate("max", "amount", [])).toBe(0);
  });

  test("null/undefined values are skipped in sum", () => {
    const mixed = [{ amount: 100 }, { amount: null }, { amount: undefined }, { amount: 50 }];
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    expect(computeAggregate("sum", "amount", mixed as any)).toBe(150);
  });

  test("NaN values are skipped", () => {
    const mixed = [{ amount: 100 }, { amount: "not_a_number" }, { amount: 50 }];
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    expect(computeAggregate("sum", "amount", mixed as any)).toBe(150);
  });

  test("sum without field returns 0", () => {
    expect(computeAggregate("sum", undefined, records)).toBe(0);
  });
});

// ── resolveAggregateValue ─────────────────────────────────────

describe("resolveAggregateValue", () => {
  test("sum via data provider query", async () => {
    const store = new InMemoryStore();
    await store.create("order_item", { id: "i1", order_id: "o1", amount: 100 });
    await store.create("order_item", { id: "i2", order_id: "o1", amount: 200 });
    await store.create("order_item", { id: "i3", order_id: "o2", amount: 50 });

    const relation: RelationDefinition = {
      name: "order_to_items",
      from: "order",
      to: "order_item",
      cardinality: "one_to_many",
    };

    const derived: AggregateDerived = {
      type: "aggregate",
      source: { link: "order_to_items", entity: "order_item" },
      op: "sum",
      field: "amount",
    };

    const parentRecord = { id: "o1" };
    const result = await resolveAggregateValue(derived, parentRecord, relation, store);
    expect(result).toBe(300); // Only items for order o1
  });

  test("count via data provider", async () => {
    const store = new InMemoryStore();
    await store.create("order_item", { id: "i1", order_id: "o1", amount: 100 });
    await store.create("order_item", { id: "i2", order_id: "o1", amount: 200 });

    const relation: RelationDefinition = {
      name: "order_to_items",
      from: "order",
      to: "order_item",
      cardinality: "one_to_many",
    };

    const derived: AggregateDerived = {
      type: "aggregate",
      source: { link: "order_to_items", entity: "order_item" },
      op: "count",
    };

    const result = await resolveAggregateValue(derived, { id: "o1" }, relation, store);
    expect(result).toBe(2);
  });

  test("avg via data provider", async () => {
    const store = new InMemoryStore();
    await store.create("order_item", { id: "i1", order_id: "o1", amount: 100 });
    await store.create("order_item", { id: "i2", order_id: "o1", amount: 200 });
    await store.create("order_item", { id: "i3", order_id: "o1", amount: 300 });

    const relation: RelationDefinition = {
      name: "order_to_items",
      from: "order",
      to: "order_item",
      cardinality: "one_to_many",
    };

    const derived: AggregateDerived = {
      type: "aggregate",
      source: { link: "order_to_items", entity: "order_item" },
      op: "avg",
      field: "amount",
    };

    const result = await resolveAggregateValue(derived, { id: "o1" }, relation, store);
    expect(result).toBe(200);
  });

  test("returns 0 when parent has no id", async () => {
    const store = new InMemoryStore();
    const relation: RelationDefinition = {
      name: "order_to_items",
      from: "order",
      to: "order_item",
      cardinality: "one_to_many",
    };

    const derived: AggregateDerived = {
      type: "aggregate",
      source: { link: "order_to_items", entity: "order_item" },
      op: "sum",
      field: "amount",
    };

    const result = await resolveAggregateValue(derived, {}, relation, store);
    expect(result).toBe(0);
  });

  test("returns 0 when no related records", async () => {
    const store = new InMemoryStore();
    const relation: RelationDefinition = {
      name: "order_to_items",
      from: "order",
      to: "order_item",
      cardinality: "one_to_many",
    };

    const derived: AggregateDerived = {
      type: "aggregate",
      source: { link: "order_to_items", entity: "order_item" },
      op: "sum",
      field: "amount",
    };

    const result = await resolveAggregateValue(derived, { id: "nonexistent" }, relation, store);
    expect(result).toBe(0);
  });

  test("reverse link direction (child → parent FK)", async () => {
    const store = new InMemoryStore();
    // In this scenario, the link goes child → parent (many_to_one from child perspective)
    // FK column is on the child side: `department_id`
    await store.create("employee", { id: "e1", department_id: "d1", salary: 5000 });
    await store.create("employee", { id: "e2", department_id: "d1", salary: 6000 });
    await store.create("employee", { id: "e3", department_id: "d2", salary: 7000 });

    // Link: employee.department_id → department
    const relation: RelationDefinition = {
      name: "emp_to_dept",
      from: "employee",
      to: "department",
      cardinality: "many_to_one",
    };

    const derived: AggregateDerived = {
      type: "aggregate",
      source: { link: "emp_to_dept", entity: "employee" },
      op: "sum",
      field: "salary",
    };

    // Parent is "department", child is "employee"
    // Link from=employee, to=department; child=employee → fkColumn = `department_id`
    const result = await resolveAggregateValue(derived, { id: "d1" }, relation, store);
    expect(result).toBe(11000);
  });
});

// ── DerivedPropertyEngine: aggregate integration ──────────────

describe("DerivedPropertyEngine — aggregate store fields", () => {
  function createTestEnv() {
    const store = new InMemoryStore();
    const relationRegistry = createRelationRegistry();

    // Register link
    relationRegistry.register({
      name: "order_to_items",
      from: "order",
      to: "order_item",
      cardinality: "one_to_many",
    });

    const orderSchema: EntityDefinition = {
      name: "order",
      fields: {
        customer_name: { type: "string" },
        total_amount: {
          type: "number",
          derived: {
            type: "aggregate",
            source: { link: "order_to_items", entity: "order_item" },
            op: "sum",
            field: "amount",
            strategy: "store",
          },
        },
        item_count: {
          type: "number",
          derived: {
            type: "aggregate",
            source: { link: "order_to_items", entity: "order_item" },
            op: "count",
            strategy: "store",
          },
        },
      },
    };

    const orderItemSchema: EntityDefinition = {
      name: "order_item",
      fields: {
        order_id: { type: "string", required: true },
        product_name: { type: "string" },
        amount: { type: "number", required: true },
      },
    };

    const engine = createDerivedPropertyEngine();
    engine.register([orderSchema, orderItemSchema]);
    engine.wire({ relationRegistry, dataProvider: store });

    return { store, relationRegistry, engine, orderSchema, orderItemSchema };
  }

  test("computeStoreFieldsAsync resolves aggregate fields", async () => {
    const { store, engine } = createTestEnv();

    // Seed order items
    await store.create("order_item", { id: "i1", order_id: "o1", amount: 100 });
    await store.create("order_item", { id: "i2", order_id: "o1", amount: 200 });

    const result = await engine.computeStoreFieldsAsync("order", { id: "o1" });
    expect(result.total_amount).toBe(300);
    expect(result.item_count).toBe(2);
  });

  test("computeStoreFieldsAsync returns 0 when no related records", async () => {
    const { engine } = createTestEnv();

    const result = await engine.computeStoreFieldsAsync("order", { id: "o_empty" });
    expect(result.total_amount).toBe(0);
    expect(result.item_count).toBe(0);
  });

  test("getAggregateFields returns only aggregate fields", () => {
    const { engine } = createTestEnv();

    const aggFields = engine.getAggregateFields("order");
    expect(aggFields).toHaveLength(2);
    expect(aggFields.map((f) => f.fieldName).sort()).toEqual(["item_count", "total_amount"]);
  });

  test("getAggregateFields returns empty for schema without aggregates", () => {
    const { engine } = createTestEnv();
    expect(engine.getAggregateFields("order_item")).toHaveLength(0);
  });
});

// ── DerivedPropertyEngine: cascade recalculation ──────────────

describe("DerivedPropertyEngine — cascade recalculation", () => {
  function createTestEnv() {
    const store = new InMemoryStore();
    const relationRegistry = createRelationRegistry();

    relationRegistry.register({
      name: "order_to_items",
      from: "order",
      to: "order_item",
      cardinality: "one_to_many",
    });

    const orderSchema: EntityDefinition = {
      name: "order",
      fields: {
        customer_name: { type: "string" },
        total_amount: {
          type: "number",
          derived: {
            type: "aggregate",
            source: { link: "order_to_items", entity: "order_item" },
            op: "sum",
            field: "amount",
            strategy: "store",
          },
        },
        item_count: {
          type: "number",
          derived: {
            type: "aggregate",
            source: { link: "order_to_items", entity: "order_item" },
            op: "count",
            strategy: "store",
          },
        },
      },
    };

    const orderItemSchema: EntityDefinition = {
      name: "order_item",
      fields: {
        order_id: { type: "string", required: true },
        product_name: { type: "string" },
        amount: { type: "number", required: true },
      },
    };

    const engine = createDerivedPropertyEngine();
    engine.register([orderSchema, orderItemSchema]);
    engine.wire({ relationRegistry, dataProvider: store });

    return { store, engine };
  }

  test("hasCascadeTargets returns true for child schemas", () => {
    const { engine } = createTestEnv();
    expect(engine.hasCascadeTargets("order_item")).toBe(true);
    expect(engine.hasCascadeTargets("order")).toBe(false);
  });

  test("getCascadeTargets returns correct targets", () => {
    const { engine } = createTestEnv();
    const targets = engine.getCascadeTargets("order_item");
    expect(targets).toHaveLength(2);
    expect(targets.map((t) => t.parentField).sort()).toEqual(["item_count", "total_amount"]);
    expect(targets[0].parentEntity).toBe("order");
    expect(targets[0].fkColumn).toBe("order_id");
  });

  test("cascade recalculates parent on child create", async () => {
    const { store, engine } = createTestEnv();

    // Create the parent order
    await store.create("order", {
      id: "o1",
      customer_name: "Alice",
      total_amount: 0,
      item_count: 0,
    });

    // Create a child item
    const item1 = await store.create("order_item", {
      id: "i1",
      order_id: "o1",
      amount: 100,
    });

    // Cascade
    await engine.cascadeRecalculate("order_item", item1);

    // Verify parent was updated
    const order = await store.get("order", "o1");
    expect(order.total_amount).toBe(100);
    expect(order.item_count).toBe(1);
  });

  test("cascade recalculates parent on child update", async () => {
    const { store, engine } = createTestEnv();

    await store.create("order", {
      id: "o1",
      customer_name: "Alice",
      total_amount: 300,
      item_count: 2,
    });
    await store.create("order_item", { id: "i1", order_id: "o1", amount: 100 });
    await store.create("order_item", { id: "i2", order_id: "o1", amount: 200 });

    // Update item amount
    const updated = await store.update("order_item", "i1", { amount: 150 });

    // Cascade
    await engine.cascadeRecalculate("order_item", updated);

    const order = await store.get("order", "o1");
    expect(order.total_amount).toBe(350); // 150 + 200
    expect(order.item_count).toBe(2);
  });

  test("cascade recalculates parent on child delete", async () => {
    const { store, engine } = createTestEnv();

    await store.create("order", {
      id: "o1",
      customer_name: "Alice",
      total_amount: 300,
      item_count: 2,
    });
    await store.create("order_item", { id: "i1", order_id: "o1", amount: 100 });
    await store.create("order_item", { id: "i2", order_id: "o1", amount: 200 });

    // Capture the item before deletion (as the CRUD handler would)
    const itemToDelete = await store.get("order_item", "i1");
    await store.delete("order_item", "i1");

    // Cascade using the captured record
    await engine.cascadeRecalculate("order_item", itemToDelete);

    const order = await store.get("order", "o1");
    expect(order.total_amount).toBe(200); // Only i2 remains
    expect(order.item_count).toBe(1);
  });

  test("cascade handles missing parent gracefully", async () => {
    const { engine } = createTestEnv();

    const item = { id: "i1", order_id: "nonexistent", amount: 100 };

    // Should not throw — just skip the cascade
    const updates = await engine.cascadeRecalculate("order_item", item);
    expect(updates.size).toBe(0);
  });

  test("cascade handles missing FK gracefully", async () => {
    const { engine } = createTestEnv();

    // Child record without FK value
    const item = { id: "i1", amount: 100 };
    const updates = await engine.cascadeRecalculate("order_item", item);
    expect(updates.size).toBe(0);
  });

  test("cascade returns empty for schema without targets", async () => {
    const { engine } = createTestEnv();
    const updates = await engine.cascadeRecalculate("order", { id: "o1" });
    expect(updates.size).toBe(0);
  });
});

// ── Chained derived fields depending on aggregates ────────────

describe("DerivedPropertyEngine — chained fields with aggregates", () => {
  test("expression field depending on aggregate is recomputed after aggregate", async () => {
    const store = new InMemoryStore();
    const relationRegistry = createRelationRegistry();

    relationRegistry.register({
      name: "order_to_items",
      from: "order",
      to: "order_item",
      cardinality: "one_to_many",
    });

    const orderSchema: EntityDefinition = {
      name: "order",
      fields: {
        total_amount: {
          type: "number",
          derived: {
            type: "aggregate",
            source: { link: "order_to_items", entity: "order_item" },
            op: "sum",
            field: "amount",
            strategy: "store",
          },
        },
        // Tax depends on total_amount (which is aggregate-derived)
        tax: {
          type: "number",
          derived: {
            type: "expression",
            expr: "total_amount * 0.1",
            strategy: "store",
            deps: ["total_amount"],
          },
        },
        // Grand total depends on total_amount and tax
        grand_total: {
          type: "number",
          derived: {
            type: "expression",
            expr: "total_amount + tax",
            strategy: "store",
            deps: ["total_amount", "tax"],
          },
        },
      },
    };

    const orderItemSchema: EntityDefinition = {
      name: "order_item",
      fields: {
        order_id: { type: "string", required: true },
        amount: { type: "number", required: true },
      },
    };

    const engine = createDerivedPropertyEngine();
    engine.register([orderSchema, orderItemSchema]);
    engine.wire({ relationRegistry, dataProvider: store });

    // Seed items
    await store.create("order_item", { id: "i1", order_id: "o1", amount: 100 });
    await store.create("order_item", { id: "i2", order_id: "o1", amount: 200 });

    const result = await engine.computeStoreFieldsAsync("order", { id: "o1" });
    expect(result.total_amount).toBe(300);
    expect(result.tax).toBeCloseTo(30);
    expect(result.grand_total).toBeCloseTo(330);
  });
});

// ── Aggregate with compute strategy ───────────────────────────

describe("DerivedPropertyEngine — aggregate with compute strategy", () => {
  test("resolveComputeFieldsAsync resolves aggregate on read", async () => {
    const store = new InMemoryStore();
    const relationRegistry = createRelationRegistry();

    relationRegistry.register({
      name: "order_to_items",
      from: "order",
      to: "order_item",
      cardinality: "one_to_many",
    });

    const orderSchema: EntityDefinition = {
      name: "order",
      fields: {
        live_total: {
          type: "number",
          derived: {
            type: "aggregate",
            source: { link: "order_to_items", entity: "order_item" },
            op: "sum",
            field: "amount",
            strategy: "compute",
          },
        },
      },
    };

    const orderItemSchema: EntityDefinition = {
      name: "order_item",
      fields: {
        order_id: { type: "string" },
        amount: { type: "number" },
      },
    };

    const engine = createDerivedPropertyEngine();
    engine.register([orderSchema, orderItemSchema]);
    engine.wire({ relationRegistry, dataProvider: store });

    await store.create("order_item", { id: "i1", order_id: "o1", amount: 100 });
    await store.create("order_item", { id: "i2", order_id: "o1", amount: 250 });

    const record: Record<string, unknown> = { id: "o1" };
    await engine.resolveComputeFieldsAsync("order", record);
    expect(record.live_total).toBe(350);
  });
});

// ── wire() behavior ──────────────────────────────────────────

describe("DerivedPropertyEngine — wire()", () => {
  test("wire after register rebuilds cascade map", () => {
    const store = new InMemoryStore();
    const relationRegistry = createRelationRegistry();

    relationRegistry.register({
      name: "dept_to_emp",
      from: "department",
      to: "employee",
      cardinality: "one_to_many",
    });

    const deptSchema: EntityDefinition = {
      name: "department",
      fields: {
        employee_count: {
          type: "number",
          derived: {
            type: "aggregate",
            source: { link: "dept_to_emp", entity: "employee" },
            op: "count",
            strategy: "store",
          },
        },
      },
    };

    const empSchema: EntityDefinition = {
      name: "employee",
      fields: {
        department_id: { type: "string" },
        name: { type: "string" },
      },
    };

    const engine = createDerivedPropertyEngine();
    engine.register([deptSchema, empSchema]);

    // Before wire: no cascade targets (no link registry)
    expect(engine.hasCascadeTargets("employee")).toBe(false);

    // Wire
    engine.wire({ relationRegistry, dataProvider: store });

    // After wire: cascade targets exist
    expect(engine.hasCascadeTargets("employee")).toBe(true);
    const targets = engine.getCascadeTargets("employee");
    expect(targets).toHaveLength(1);
    expect(targets[0].parentEntity).toBe("department");
    expect(targets[0].parentField).toBe("employee_count");
  });

  test("computeStoreFieldsAsync falls back to sync when not wired", async () => {
    const schema: EntityDefinition = {
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
          },
        },
      },
    };

    const engine = createDerivedPropertyEngine();
    engine.register([schema]);
    // Not wired — should still work for non-aggregate fields

    const result = await engine.computeStoreFieldsAsync("product", { price: 100, cost: 60 });
    expect(result.margin).toBe(40);
  });
});

// ── Multiple parent schemas ──────────────────────────────────

describe("DerivedPropertyEngine — multiple parent schemas", () => {
  test("cascade to multiple parent schemas", async () => {
    const store = new InMemoryStore();
    const relationRegistry = createRelationRegistry();

    relationRegistry.register({
      name: "project_to_tasks",
      from: "project",
      to: "task",
      cardinality: "one_to_many",
    });
    relationRegistry.register({
      name: "sprint_to_tasks",
      from: "sprint",
      to: "task",
      cardinality: "one_to_many",
    });

    const projectSchema: EntityDefinition = {
      name: "project",
      fields: {
        task_count: {
          type: "number",
          derived: {
            type: "aggregate",
            source: { link: "project_to_tasks", entity: "task" },
            op: "count",
            strategy: "store",
          },
        },
      },
    };

    const sprintSchema: EntityDefinition = {
      name: "sprint",
      fields: {
        total_effort: {
          type: "number",
          derived: {
            type: "aggregate",
            source: { link: "sprint_to_tasks", entity: "task" },
            op: "sum",
            field: "effort",
            strategy: "store",
          },
        },
      },
    };

    const taskSchema: EntityDefinition = {
      name: "task",
      fields: {
        project_id: { type: "string" },
        sprint_id: { type: "string" },
        effort: { type: "number" },
      },
    };

    const engine = createDerivedPropertyEngine();
    engine.register([projectSchema, sprintSchema, taskSchema]);
    engine.wire({ relationRegistry, dataProvider: store });

    // Create parents
    await store.create("project", { id: "p1", task_count: 0 });
    await store.create("sprint", { id: "s1", total_effort: 0 });

    // Create task belonging to both
    const task = await store.create("task", {
      id: "t1",
      project_id: "p1",
      sprint_id: "s1",
      effort: 5,
    });

    // Cascade
    await engine.cascadeRecalculate("task", task);

    const project = await store.get("project", "p1");
    expect(project.task_count).toBe(1);

    const sprint = await store.get("sprint", "s1");
    expect(sprint.total_effort).toBe(5);
  });
});

// ── Cascade with dependent expression fields ──────────────────

describe("DerivedPropertyEngine — cascade updates dependent expression fields", () => {
  test("cascade recalculates expression fields that depend on aggregate fields", async () => {
    const store = new InMemoryStore();
    const relationRegistry = createRelationRegistry();

    relationRegistry.register({
      name: "order_to_items",
      from: "order",
      to: "order_item",
      cardinality: "one_to_many",
    });

    const orderSchema: EntityDefinition = {
      name: "order",
      fields: {
        total_amount: {
          type: "number",
          derived: {
            type: "aggregate",
            source: { link: "order_to_items", entity: "order_item" },
            op: "sum",
            field: "amount",
            strategy: "store",
          },
        },
        // This expression field depends on the aggregate
        is_large_order: {
          type: "number",
          derived: {
            type: "expression",
            expr: "total_amount > 500",
            strategy: "store",
            deps: ["total_amount"],
          },
        },
      },
    };

    const orderItemSchema: EntityDefinition = {
      name: "order_item",
      fields: {
        order_id: { type: "string" },
        amount: { type: "number" },
      },
    };

    const engine = createDerivedPropertyEngine();
    engine.register([orderSchema, orderItemSchema]);
    engine.wire({ relationRegistry, dataProvider: store });

    // Create parent
    await store.create("order", {
      id: "o1",
      total_amount: 0,
      is_large_order: 0,
    });

    // Add items exceeding threshold
    await store.create("order_item", { id: "i1", order_id: "o1", amount: 300 });
    const item2 = await store.create("order_item", { id: "i2", order_id: "o1", amount: 400 });

    // Cascade
    await engine.cascadeRecalculate("order_item", item2);

    const order = await store.get("order", "o1");
    expect(order.total_amount).toBe(700);
    // is_large_order should be 1 (true) since 700 > 500
    expect(order.is_large_order).toBe(1);
  });
});

// ── Recursive cascade with depth limit ────────────────────────

describe("DerivedPropertyEngine — recursive cascade", () => {
  test("cascades recursively through multiple levels", async () => {
    const store = new InMemoryStore();
    const relationRegistry = createRelationRegistry();

    // Chain: company -> department -> employee
    relationRegistry.register({
      name: "company_to_depts",
      from: "company",
      to: "department",
      cardinality: "one_to_many",
    });
    relationRegistry.register({
      name: "dept_to_employees",
      from: "department",
      to: "employee",
      cardinality: "one_to_many",
    });

    const companySchema: EntityDefinition = {
      name: "company",
      fields: {
        total_departments: {
          type: "number",
          derived: {
            type: "aggregate",
            source: { link: "company_to_depts", entity: "department" },
            op: "sum",
            field: "employee_count",
            strategy: "store",
          },
        },
      },
    };

    const departmentSchema: EntityDefinition = {
      name: "department",
      fields: {
        company_id: { type: "string" },
        employee_count: {
          type: "number",
          derived: {
            type: "aggregate",
            source: { link: "dept_to_employees", entity: "employee" },
            op: "count",
            strategy: "store",
          },
        },
      },
    };

    const employeeSchema: EntityDefinition = {
      name: "employee",
      fields: {
        department_id: { type: "string" },
        name: { type: "string" },
      },
    };

    const engine = createDerivedPropertyEngine();
    engine.register([companySchema, departmentSchema, employeeSchema]);
    engine.wire({ relationRegistry, dataProvider: store });

    // Create company and department
    await store.create("company", { id: "c1", total_departments: 0 });
    await store.create("department", { id: "d1", company_id: "c1", employee_count: 0 });

    // Add an employee — should cascade to department, then to company
    const emp = await store.create("employee", { id: "e1", department_id: "d1", name: "Alice" });
    const updates = await engine.cascadeRecalculate("employee", emp);

    // Department should have employee_count = 1
    const dept = await store.get("department", "d1");
    expect(dept.employee_count).toBe(1);

    // Company should have total_departments = 1 (sum of employee_count across departments)
    const company = await store.get("company", "c1");
    expect(company.total_departments).toBe(1);

    // Should have updates for both levels
    expect(updates.has("department.d1")).toBe(true);
    expect(updates.has("company.c1")).toBe(true);
  });

  test("respects maxCascadeDepth limit", async () => {
    const store = new InMemoryStore();
    const relationRegistry = createRelationRegistry();

    // Same chain as above
    relationRegistry.register({
      name: "company_to_depts",
      from: "company",
      to: "department",
      cardinality: "one_to_many",
    });
    relationRegistry.register({
      name: "dept_to_employees",
      from: "department",
      to: "employee",
      cardinality: "one_to_many",
    });

    const companySchema: EntityDefinition = {
      name: "company",
      fields: {
        total_departments: {
          type: "number",
          derived: {
            type: "aggregate",
            source: { link: "company_to_depts", entity: "department" },
            op: "sum",
            field: "employee_count",
            strategy: "store",
          },
        },
      },
    };

    const departmentSchema: EntityDefinition = {
      name: "department",
      fields: {
        company_id: { type: "string" },
        employee_count: {
          type: "number",
          derived: {
            type: "aggregate",
            source: { link: "dept_to_employees", entity: "employee" },
            op: "count",
            strategy: "store",
          },
        },
      },
    };

    const employeeSchema: EntityDefinition = {
      name: "employee",
      fields: {
        department_id: { type: "string" },
        name: { type: "string" },
      },
    };

    const engine = createDerivedPropertyEngine();
    engine.register([companySchema, departmentSchema, employeeSchema]);
    engine.wire({ relationRegistry, dataProvider: store });

    await store.create("company", { id: "c1", total_departments: 0 });
    await store.create("department", { id: "d1", company_id: "c1", employee_count: 0 });

    const emp = await store.create("employee", { id: "e1", department_id: "d1", name: "Bob" });

    // With maxCascadeDepth=1, should only cascade one level (employee → department)
    const updates = await engine.cascadeRecalculate("employee", emp, undefined, {
      maxCascadeDepth: 1,
    });

    // Department should be updated
    const dept = await store.get("department", "d1");
    expect(dept.employee_count).toBe(1);

    // Company should NOT be updated (depth limit reached)
    const company = await store.get("company", "c1");
    expect(company.total_departments).toBe(0);

    expect(updates.has("department.d1")).toBe(true);
    expect(updates.has("company.c1")).toBe(false);
  });
});
