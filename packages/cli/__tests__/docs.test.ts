/**
 * Tests for `linch docs` (Spec 25, Issue #75) — pure helpers.
 *
 * Exercises `generateProjectDoc` + `renderProjectDoc` against an in-memory
 * OntologyRegistry built from a single fixture capability covering every
 * meta-model artifact: entity, action, rule, state machine, view, flow,
 * relation. Avoids spawning the CLI (citty + loadConfig) so the test is
 * fast and free of project filesystem state.
 */

import { describe, expect, it } from "bun:test";
import {
  defineAction,
  defineEntity,
  defineRelation,
  defineRule,
  defineState,
  defineView,
  type FlowDefinition,
} from "@linchkit/core";
import {
  ActionRegistry,
  createFlowRegistry,
  createOntologyRegistry,
  createRelationRegistry,
  EntityRegistry,
} from "@linchkit/core/server";
import { generateProjectDoc, renderProjectDoc } from "@linchkit/devtools/documentation";

// ── Fixtures ─────────────────────────────────────────────

const orderEntity = defineEntity({
  name: "order",
  label: "Order",
  description: "A purchase order",
  fields: {
    title: { type: "text", required: true, label: "Title" },
    amount: { type: "number", required: true, label: "Amount", min: 0 },
    status: { type: "state", machine: "order_status", label: "Status" },
  },
});

const departmentEntity = defineEntity({
  name: "department",
  label: "Department",
  fields: {
    name: { type: "text", required: true, label: "Name" },
  },
});

const submitOrder = defineAction({
  name: "submit_order",
  entity: "order",
  label: "Submit order",
  description: "Submit an order for approval",
  input: { note: { type: "text", label: "Note" } },
  output: { submitted_at: { type: "datetime", label: "Submitted at" } },
  stateTransition: { from: "draft", to: "submitted" },
  setFields: { status: "submitted" },
  policy: { mode: "sync", transaction: true },
});

const approveOrder = defineAction({
  name: "approve_order",
  entity: "order",
  label: "Approve order",
  stateTransition: { from: "submitted", to: "approved" },
  policy: { mode: "sync", transaction: true },
});

const orderStatus = defineState({
  name: "order_status",
  entity: "order",
  field: "status",
  initial: "draft",
  states: ["draft", "submitted", "approved", "rejected"],
  transitions: [
    { from: "draft", to: "submitted", action: "submit_order" },
    { from: "submitted", to: "approved", action: "approve_order" },
    { from: "submitted", to: "rejected", action: "reject_order" },
  ],
});

const orderDeptRelation = defineRelation({
  name: "order_department",
  from: "order",
  to: "department",
  cardinality: "many_to_one",
  fromName: "department",
  toName: "orders",
  description: "Department that placed the order",
});

const amountCheck = defineRule({
  name: "amount_check",
  label: "Amount over 10000 requires approval",
  description: "Big-ticket orders need a director approval gate",
  trigger: { action: "submit_order" },
  condition: { field: "amount", operator: "gt", value: 10000 },
  effect: { type: "require_approval", level: "director" },
});

const orderListView = defineView({
  name: "order_list",
  entity: "order",
  type: "list",
  label: "Orders",
  fields: [{ field: "title" }, { field: "amount" }, { field: "status" }],
});

// Inline FlowDefinition: no defineFlow() helper exists yet (spec 23).
const approvalFlow: FlowDefinition = {
  name: "approval_flow",
  label: "Approval Flow",
  description: "Director-level approval pipeline",
  trigger: { type: "event", eventType: "order.submit_order.succeeded" },
  steps: [
    {
      id: "wait_for_director",
      name: "Wait for director approval",
      type: "approval",
      approvers: ["director"],
    },
    {
      id: "do_approve",
      name: "Approve order",
      type: "action",
      actionName: "approve_order",
    },
  ],
  onError: "abort",
};

// ── Helper: build a minimal OntologyRegistry ─────────────────

function buildOntology() {
  const entityRegistry = new EntityRegistry();
  // Register out of alphabetical order so we can assert generateProjectDoc
  // sorts entities deterministically.
  entityRegistry.register(orderEntity);
  entityRegistry.register(departmentEntity);

  const actionRegistry = new ActionRegistry();
  actionRegistry.register(submitOrder);
  actionRegistry.register(approveOrder);

  const relationRegistry = createRelationRegistry();
  relationRegistry.register(orderDeptRelation);

  const flowRegistry = createFlowRegistry();
  flowRegistry.register(approvalFlow);

  return createOntologyRegistry({
    schemas: entityRegistry,
    actions: actionRegistry,
    rules: [amountCheck],
    states: [orderStatus],
    views: [orderListView],
    links: relationRegistry,
    flows: flowRegistry,
  });
}

// ── Tests ────────────────────────────────────────────────

describe("generateProjectDoc", () => {
  it("walks every meta-model artifact and emits structured doc objects", () => {
    const ontology = buildOntology();
    const doc = generateProjectDoc(ontology, {
      title: "Test Docs",
      generatedAt: "2026-05-16T00:00:00.000Z",
      rules: [amountCheck],
      states: [orderStatus],
      views: [orderListView],
      flows: [approvalFlow],
      relations: [orderDeptRelation],
    });

    expect(doc.title).toBe("Test Docs");
    // Sorted alphabetically: department, order (registered out of order).
    expect(doc.entities.map((e) => e.name)).toEqual(["department", "order"]);

    // The order entity carries its actions through the OntologyRegistry.
    const orderDoc = doc.entities.find((e) => e.name === "order");
    expect(orderDoc?.actions.map((a) => a.name).sort()).toEqual(["approve_order", "submit_order"]);
    // State machine surfaces under the entity that defines it.
    expect(orderDoc?.stateMachine?.name).toBe("order_status");
    expect(orderDoc?.stateMachine?.initial).toBe("draft");

    // Rule: trigger and effect summarized as human-readable strings.
    expect(doc.rules).toHaveLength(1);
    expect(doc.rules[0]?.triggerSummary).toBe("action: submit_order");
    expect(doc.rules[0]?.effectSummary).toBe("require_approval (level=director)");

    // State machine top-level section.
    expect(doc.stateMachines).toHaveLength(1);
    expect(doc.stateMachines[0]?.transitions).toHaveLength(3);

    // Views, flows, relations.
    expect(doc.views.map((v) => v.name)).toEqual(["order_list"]);
    expect(doc.flows[0]?.triggerSummary).toBe("event: order.submit_order.succeeded");
    expect(doc.flows[0]?.stepCount).toBe(2);
    expect(doc.relations[0]?.cardinality).toBe("many_to_one");
  });

  it("produces deterministic markdown including all top-level sections", () => {
    const ontology = buildOntology();
    const doc = generateProjectDoc(ontology, {
      title: "Test Docs",
      generatedAt: "2026-05-16T00:00:00.000Z",
      rules: [amountCheck],
      states: [orderStatus],
      views: [orderListView],
      flows: [approvalFlow],
      relations: [orderDeptRelation],
    });
    const markdown = renderProjectDoc(doc);

    // Header + auto-generated banner.
    expect(markdown).toContain("# Test Docs");
    expect(markdown).toContain("> Generated at 2026-05-16T00:00:00.000Z");
    expect(markdown).toContain("auto-generated from `defineXxx()` calls");

    // Summary counts.
    expect(markdown).toContain("- Entities: 2");
    expect(markdown).toContain("- Actions: 2");
    expect(markdown).toContain("- Rules: 1");
    expect(markdown).toContain("- State Machines: 1");
    expect(markdown).toContain("- Views: 1");
    expect(markdown).toContain("- Flows: 1");
    expect(markdown).toContain("- Relations: 1");

    // Every top-level section heading present.
    expect(markdown).toContain("## Entities");
    expect(markdown).toContain("## Rules");
    expect(markdown).toContain("## State Machines");
    expect(markdown).toContain("## Views");
    expect(markdown).toContain("## Flows");
    expect(markdown).toContain("## Relations");

    // Field table for entity.
    expect(markdown).toContain("| Name | Type | Required | Description |");
    expect(markdown).toContain("| amount | number | yes |");

    // Rule body.
    expect(markdown).toContain("Trigger: action: submit_order");
    expect(markdown).toContain("Effect: require_approval (level=director)");

    // Relation body.
    expect(markdown).toContain("`order_department`");
    expect(markdown).toContain("(many_to_one");

    // Determinism: re-running with the same input must produce byte-identical
    // output (no clock-driven drift, no Map iteration order surprises).
    const second = renderProjectDoc(
      generateProjectDoc(ontology, {
        title: "Test Docs",
        generatedAt: "2026-05-16T00:00:00.000Z",
        rules: [amountCheck],
        states: [orderStatus],
        views: [orderListView],
        flows: [approvalFlow],
        relations: [orderDeptRelation],
      }),
    );
    expect(second).toBe(markdown);

    // Trailing newline (single) for stable diffs.
    expect(markdown.endsWith("\n")).toBe(true);
    expect(markdown.endsWith("\n\n")).toBe(false);
  });

  it("emits an empty-but-valid doc when no artifacts are present", () => {
    const entityRegistry = new EntityRegistry();
    const actionRegistry = new ActionRegistry();
    const ontology = createOntologyRegistry({
      schemas: entityRegistry,
      actions: actionRegistry,
      rules: [],
      states: [],
      views: [],
    });
    const doc = generateProjectDoc(ontology, {
      generatedAt: "2026-05-16T00:00:00.000Z",
    });
    const markdown = renderProjectDoc(doc);

    expect(doc.entities).toHaveLength(0);
    // Summary still emitted; no per-section headings appear when their list is
    // empty so the doc isn't littered with empty section bodies.
    expect(markdown).toContain("- Entities: 0");
    expect(markdown).not.toContain("## Entities");
    expect(markdown).not.toContain("## Rules");
  });
});
