/**
 * Tests for ontology/describe helpers
 */

import { describe, expect, test } from "bun:test";
import {
  buildProjectOverview,
  type DescribeInput,
  describeAction,
  describeEntity,
  describeRelation,
} from "../src/ontology/describe";
import type { ActionDefinition } from "../src/types/action";
import type { EntityDefinition } from "../src/types/entity";
import type { RelationDefinition } from "../src/types/relation";
import type { StateDefinition } from "../src/types/state";
import type { ViewDefinition } from "../src/types/view";

// ── Fixtures ─────────────────────────────────────────────

const orderEntity: EntityDefinition = {
  name: "purchase_order",
  label: "Purchase Order",
  description: "A purchase order",
  fields: {
    id: { type: "uuid", required: true },
    title: { type: "string", required: true, label: "Title" },
    amount: { type: "number", min: 0 },
    status: { type: "string" },
    _extensions: { type: "json" },
  },
};

const departmentEntity: EntityDefinition = {
  name: "department",
  label: "Department",
  fields: {
    id: { type: "uuid", required: true },
    name: { type: "string", required: true },
  },
};

const createOrderAction: ActionDefinition = {
  name: "create_purchase_order",
  entity: "purchase_order",
  label: "Create Purchase Order",
  description: "Creates a new purchase order",
  input: {
    title: { type: "string", required: true },
    amount: { type: "number", min: 0 },
  },
  policy: "create",
};

const approveOrderAction: ActionDefinition = {
  name: "approve_purchase_order",
  entity: "purchase_order",
  label: "Approve Purchase Order",
  stateTransition: { from: "submitted", to: "approved" },
  setFields: { approved_at: { $now: true } },
  policy: "custom",
};

const orderState: StateDefinition = {
  name: "purchase_order_lifecycle",
  entity: "purchase_order",
  field: "status",
  initial: "draft",
  states: ["draft", "submitted", "approved", "rejected"],
  transitions: [
    { from: "draft", to: "submitted", action: "submit_purchase_order" },
    { from: "submitted", to: "approved", action: "approve_purchase_order" },
    { from: "submitted", to: "rejected", action: "reject_purchase_order" },
  ],
};

const orderDeptRelation: RelationDefinition = {
  name: "order_department",
  from: "purchase_order",
  to: "department",
  cardinality: "many_to_one",
  label: { from: "Department", to: "Purchase Orders" },
  required: true,
  cascade: "nullify",
};

const orderListView: ViewDefinition = {
  name: "purchase_order_list",
  entity: "purchase_order",
  type: "list",
  columns: [],
};

// ── buildProjectOverview ────────────────────────────────

describe("buildProjectOverview", () => {
  test("counts all definitions correctly", () => {
    const input: DescribeInput = {
      capabilities: [
        {
          name: "cap-purchase",
          type: "standard",
          version: "1.0.0",
          entities: [orderEntity, departmentEntity],
          actions: [createOrderAction, approveOrderAction],
          rules: [
            {
              name: "auto_approve",
              label: "Auto Approve",
              trigger: { action: "create_purchase_order" },
              conditions: [],
              effects: [],
            },
          ],
          states: [orderState],
          flows: [],
          relations: [orderDeptRelation],
          views: [orderListView],
        },
      ],
    };

    const overview = buildProjectOverview(input);

    expect(overview.capabilities).toHaveLength(1);
    expect(overview.capabilities[0]?.name).toBe("cap-purchase");
    expect(overview.entities).toHaveLength(2);
    expect(overview.actions).toHaveLength(2);
    expect(overview.rules).toHaveLength(1);
    expect(overview.states).toHaveLength(1);
    expect(overview.states[0]?.stateCount).toBe(4);
    expect(overview.flows).toHaveLength(0);
    expect(overview.relations).toHaveLength(1);
    expect(overview.relations[0]?.type).toBe("many_to_one");
  });

  test("aggregates across multiple capabilities", () => {
    const input: DescribeInput = {
      capabilities: [
        {
          name: "cap-a",
          type: "standard",
          version: "1.0.0",
          entities: [orderEntity],
          actions: [createOrderAction],
        },
        {
          name: "cap-b",
          type: "standard",
          version: "1.0.0",
          entities: [departmentEntity],
          actions: [approveOrderAction],
        },
      ],
    };

    const overview = buildProjectOverview(input);
    expect(overview.capabilities).toHaveLength(2);
    expect(overview.entities).toHaveLength(2);
    expect(overview.actions).toHaveLength(2);
  });

  test("handles empty capabilities", () => {
    const overview = buildProjectOverview({ capabilities: [] });
    expect(overview.capabilities).toHaveLength(0);
    expect(overview.entities).toHaveLength(0);
    expect(overview.actions).toHaveLength(0);
  });
});

// ── describeEntity ──────────────────────────────────────

describe("describeEntity", () => {
  test("returns field info with types and constraints", () => {
    const desc = describeEntity(orderEntity);

    expect(desc.name).toBe("purchase_order");
    expect(desc.label).toBe("Purchase Order");
    expect(desc.fields).toHaveLength(5);

    const idField = desc.fields.find((f) => f.name === "id");
    expect(idField?.type).toBe("uuid");
    expect(idField?.system).toBe(true);
    expect(idField?.required).toBe(true);

    const amountField = desc.fields.find((f) => f.name === "amount");
    expect(amountField?.constraints?.min).toBe(0);
    expect(amountField?.system).toBe(false);
  });

  test("includes related actions filtered by entity", () => {
    const desc = describeEntity(orderEntity, {
      actions: [createOrderAction, approveOrderAction],
    });
    expect(desc.actions).toHaveLength(2);
    expect(desc.actions.map((a) => a.name)).toContain("create_purchase_order");
  });

  test("includes state machine when matching", () => {
    const desc = describeEntity(orderEntity, {
      states: [orderState],
    });
    expect(desc.states).toBeDefined();
    expect(desc.states?.name).toBe("purchase_order_lifecycle");
    expect(desc.states?.initial).toBe("draft");
    expect(desc.states?.states).toHaveLength(4);
  });

  test("includes relations", () => {
    const desc = describeEntity(orderEntity, {
      relations: [orderDeptRelation],
    });
    expect(desc.relations).toHaveLength(1);
    expect(desc.relations[0]?.direction).toBe("outgoing");
    expect(desc.relations[0]?.target).toBe("department");
  });

  test("includes views filtered by entity", () => {
    const desc = describeEntity(orderEntity, {
      views: [orderListView],
    });
    expect(desc.views).toHaveLength(1);
    expect(desc.views[0]?.type).toBe("list");
  });

  test("entity with no related definitions returns empty arrays", () => {
    const desc = describeEntity(departmentEntity);
    expect(desc.actions).toHaveLength(0);
    expect(desc.states).toBeUndefined();
    expect(desc.relations).toHaveLength(0);
    expect(desc.views).toHaveLength(0);
  });
});

// ── describeAction ──────────────────────────────────────

describe("describeAction", () => {
  test("returns input fields", () => {
    const desc = describeAction(createOrderAction);
    expect(desc.name).toBe("create_purchase_order");
    expect(desc.entity).toBe("purchase_order");
    expect(desc.input).toHaveLength(2);
    expect(desc.input.find((f) => f.name === "title")?.required).toBe(true);
  });

  test("includes state transition and setFields effects", () => {
    const desc = describeAction(approveOrderAction);
    expect(desc.stateTransition).toBeDefined();
    expect(desc.stateTransition?.from).toBe("submitted");
    expect(desc.stateTransition?.to).toBe("approved");
    expect(desc.effects).toHaveLength(2);
    expect(desc.effects[0]).toContain("State:");
    expect(desc.effects[1]).toContain("Sets fields:");
  });

  test("action with no input/output returns empty arrays", () => {
    const desc = describeAction({
      name: "simple_action",
      entity: "test",
      label: "Simple",
      policy: "custom",
    });
    expect(desc.input).toHaveLength(0);
    expect(desc.output).toHaveLength(0);
    expect(desc.effects).toHaveLength(0);
  });
});

// ── describeRelation ────────────────────────────────────

describe("describeRelation", () => {
  test("returns full relation details", () => {
    const desc = describeRelation(orderDeptRelation);
    expect(desc.name).toBe("order_department");
    expect(desc.from).toBe("purchase_order");
    expect(desc.to).toBe("department");
    expect(desc.cardinality).toBe("many_to_one");
    expect(desc.required).toBe(true);
    expect(desc.cascade).toBe("nullify");
    expect(desc.label?.from).toBe("Department");
    expect(desc.label?.to).toBe("Purchase Orders");
  });

  test("defaults cascade to none", () => {
    const desc = describeRelation({
      name: "simple_link",
      from: "a",
      to: "b",
      cardinality: "one_to_many",
    });
    expect(desc.cascade).toBe("none");
    expect(desc.required).toBe(false);
    expect(desc.properties).toHaveLength(0);
  });

  test("includes junction table properties for M:N", () => {
    const desc = describeRelation({
      name: "order_tags",
      from: "purchase_order",
      to: "tag",
      cardinality: "many_to_many",
      properties: {
        weight: { type: "number", min: 0, max: 100 },
      },
    });
    expect(desc.properties).toHaveLength(1);
    expect(desc.properties[0]?.name).toBe("weight");
    expect(desc.properties[0]?.constraints?.min).toBe(0);
  });
});
