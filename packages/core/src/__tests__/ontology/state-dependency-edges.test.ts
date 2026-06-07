/**
 * State dependency DAG edges — Spec 67 §4.1
 *
 * Verifies the two state-related dependency edges that close the documented
 * impactAnalysis gap:
 *  1. State.transitions[].action → `state_transition` edge (State depends on Action).
 *  2. Entity `type: "state"` field's `machine` → `state_machine` edge (Entity
 *     depends on State).
 *
 * These edges let `impactAnalysis` (and therefore validation Phase 3) flag the
 * deletion of an action used only as a state transition, or of a state machine
 * attached to an entity, as breaking.
 */

import { describe, expect, test } from "bun:test";
import {
  createOntologyRegistry,
  extractDependencyEdges,
  type OntologyRegistryDeps,
} from "../../ontology";
import type { ActionDefinition } from "../../types/action";
import type { EntityDefinition } from "../../types/entity";
import type { MetaModelRef } from "../../types/meta-semantics";
import type { StateDefinition } from "../../types/state";

// ── Fixtures ─────────────────────────────────────────────

const orderEntity: EntityDefinition = {
  name: "order",
  label: "Order",
  fields: {
    title: { type: "string", label: "Title", required: true },
    // `type: "state"` field whose `machine` references the order_state machine.
    status: { type: "state", label: "Status", machine: "order_state" },
  },
};

const approveAction: ActionDefinition = {
  name: "approve_order",
  entity: "order",
  label: "Approve Order",
  policy: { mode: "sync", transaction: true },
} as unknown as ActionDefinition;

// Action used ONLY as a state transition (no rule/flow/handler references it).
const submitAction: ActionDefinition = {
  name: "submit_order",
  entity: "order",
  label: "Submit Order",
  policy: { mode: "sync", transaction: true },
} as unknown as ActionDefinition;

// Action referenced by nothing at all — regression control.
const archiveAction: ActionDefinition = {
  name: "archive_order",
  entity: "order",
  label: "Archive Order",
  policy: { mode: "sync", transaction: true },
} as unknown as ActionDefinition;

const orderState: StateDefinition = {
  name: "order_state",
  entity: "order",
  field: "status",
  initial: "draft",
  states: ["draft", "submitted", "approved"],
  transitions: [
    { from: "draft", to: "submitted", action: "submit_order" },
    { from: "submitted", to: "approved", action: "approve_order" },
    // Duplicate action across a second transition — must NOT produce a duplicate edge.
    { from: "draft", to: "approved", action: "approve_order" },
  ],
};

function buildOntology(overrides?: Partial<OntologyRegistryDeps>) {
  const deps: OntologyRegistryDeps = {
    schemas: {
      getAll: () => [orderEntity],
      get: (name: string) => (name === orderEntity.name ? orderEntity : undefined),
      has: (name: string) => name === orderEntity.name,
    },
    actions: { getAll: () => [approveAction, submitAction, archiveAction] },
    rules: [],
    states: [orderState],
    views: [],
    ...overrides,
  };
  return createOntologyRegistry(deps);
}

function hasRef(refs: MetaModelRef[], type: MetaModelRef["type"], name: string): boolean {
  return refs.some((r) => r.type === type && r.name === name);
}

// ── extractDependencyEdges: edge production ──────────────

describe("extractDependencyEdges — state edges", () => {
  const edges = extractDependencyEdges({
    entities: [orderEntity],
    actions: [approveAction, submitAction, archiveAction],
    rules: [],
    states: [orderState],
    events: [],
    handlers: [],
    flows: [],
    views: [],
    relations: [],
  });

  test("adds a state_transition edge from State to each transition Action", () => {
    const transitionEdges = edges.filter((e) => e.type === "state_transition");
    // Two distinct transition actions (approve_order, submit_order); the
    // duplicate approve_order transition must be deduped.
    expect(transitionEdges).toHaveLength(2);
    for (const e of transitionEdges) {
      expect(e.from).toEqual({ type: "state", name: "order_state" });
      expect(e.to.type).toBe("action");
    }
    const toNames = transitionEdges.map((e) => e.to.name).sort();
    expect(toNames).toEqual(["approve_order", "submit_order"]);
  });

  test("adds a state_machine edge from Entity to the referenced State", () => {
    const machineEdges = edges.filter((e) => e.type === "state_machine");
    expect(machineEdges).toHaveLength(1);
    expect(machineEdges[0]).toEqual({
      from: { type: "entity", name: "order" },
      to: { type: "state", name: "order_state" },
      type: "state_machine",
    });
  });

  test("adds a state_machine edge from StateDefinition.entity even when the entity has no state field", () => {
    // The entity has no `type: "state"` field referencing the machine (so the
    // field-scan fallback finds nothing), but the registered StateDefinition
    // authoritatively declares entity:"task" — the edge must still be produced.
    const taskEntity: EntityDefinition = {
      name: "task",
      fields: { title: { type: "string" } },
    };
    const taskState: StateDefinition = {
      name: "task_state",
      entity: "task",
      field: "status",
      initial: "open",
      states: ["open", "done"],
      transitions: [],
    };
    const out = extractDependencyEdges({
      entities: [taskEntity],
      actions: [],
      rules: [],
      states: [taskState],
      events: [],
      handlers: [],
      flows: [],
      views: [],
      relations: [],
    });
    expect(out.filter((e) => e.type === "state_machine")).toEqual([
      {
        from: { type: "entity", name: "task" },
        to: { type: "state", name: "task_state" },
        type: "state_machine",
      },
    ]);
  });

  test("does not add a state_transition edge for an unknown action", () => {
    const danglingState: StateDefinition = {
      name: "dangling_state",
      entity: "order",
      field: "status",
      initial: "a",
      states: ["a", "b"],
      transitions: [{ from: "a", to: "b", action: "no_such_action" }],
    };
    const out = extractDependencyEdges({
      entities: [],
      actions: [approveAction],
      rules: [],
      states: [danglingState],
      events: [],
      handlers: [],
      flows: [],
      views: [],
      relations: [],
    });
    expect(out.filter((e) => e.type === "state_transition")).toHaveLength(0);
  });

  test("does not add a state_machine edge for an unknown machine name", () => {
    const entityWithDanglingMachine: EntityDefinition = {
      name: "thing",
      fields: { status: { type: "state", machine: "no_such_machine" } },
    };
    const out = extractDependencyEdges({
      entities: [entityWithDanglingMachine],
      actions: [],
      rules: [],
      states: [orderState],
      events: [],
      handlers: [],
      flows: [],
      views: [],
      relations: [],
    });
    expect(out.filter((e) => e.type === "state_machine")).toHaveLength(0);
  });
});

// ── impactAnalysis: dependents surfaced ──────────────────

describe("impactAnalysis — state edges", () => {
  test("an action used ONLY as a state transition returns the owning state", () => {
    const ontology = buildOntology();
    // submit_order is referenced only by order_state's transition.
    const layers = ontology.impactAnalysis({ type: "action", name: "submit_order" });
    const dependents = layers.slice(1).flat();
    expect(hasRef(dependents, "state", "order_state")).toBe(true);
  });

  test("a state machine attached to an entity returns that entity", () => {
    const ontology = buildOntology();
    const layers = ontology.impactAnalysis({ type: "state", name: "order_state" });
    const dependents = layers.slice(1).flat();
    expect(hasRef(dependents, "entity", "order")).toBe(true);
  });

  test("an action not referenced anywhere still returns no dependents (regression)", () => {
    const ontology = buildOntology();
    const layers = ontology.impactAnalysis({ type: "action", name: "archive_order" });
    const dependents = layers.slice(1).flat();
    expect(dependents).toHaveLength(0);
  });
});

// ── dependencyGraph: forward reachability ────────────────

describe("dependencyGraph — state edges", () => {
  test("entity → state → transition actions are reachable forward", () => {
    const ontology = buildOntology();
    const graph = ontology.dependencyGraph({ type: "entity", name: "order" });
    // entity:order --state_machine--> state:order_state --state_transition--> actions
    expect(hasRef(graph.nodes, "state", "order_state")).toBe(true);
    expect(hasRef(graph.nodes, "action", "approve_order")).toBe(true);
    expect(hasRef(graph.nodes, "action", "submit_order")).toBe(true);
  });
});
