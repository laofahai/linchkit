/**
 * Spec 67 — MetaSemantics: structural inference and OntologyRegistry semantic API
 */

import { describe, expect, test } from "bun:test";
import {
  bfsForward,
  bfsReverse,
  createOntologyRegistry,
  extractDependencyEdges,
  inferActionSemantics,
  inferEntitySemantics,
  type OntologyRegistryDeps,
} from "../src/ontology";
import type { ActionDefinition } from "../src/types/action";
import type { EntityDefinition } from "../src/types/entity";
import type { FlowDefinition } from "../src/types/flow";
import type { MetaModelRef } from "../src/types/meta-semantics";
import type { RelationDefinition } from "../src/types/relation";
import type { RuleDefinition } from "../src/types/rule";
import type { StateDefinition } from "../src/types/state";
import type { ViewDefinition } from "../src/types/view";

// ── Shared fixtures ───────────────────────────────────────────────────────────

const purchaseRequestEntity: EntityDefinition = {
  name: "purchase_request",
  label: "Purchase Request",
  fields: {
    title: { type: "string", label: "Title", required: true },
    amount: { type: "number", label: "Amount" },
    status: { type: "state", label: "Status" },
  },
};

const departmentEntity: EntityDefinition = {
  name: "department",
  label: "Department",
  fields: { name: { type: "string", label: "Name" } },
};

const auditLogEntity: EntityDefinition = {
  name: "purchase_audit_log",
  label: "Purchase Audit Log",
  fields: { action: { type: "string", label: "Action" } },
};

const submitAction: ActionDefinition = {
  name: "submit_request",
  entity: "purchase_request",
  label: "Submit Request",
  policy: { mode: "sync", transaction: true },
  stateTransition: { from: "draft", to: "pending" },
};

const approveAction: ActionDefinition = {
  name: "approve_request",
  entity: "purchase_request",
  label: "Approve Request",
  policy: { mode: "sync", transaction: true, failurePolicy: "compensate" },
  sideEffects: [{ type: "emit_event", target: "purchase_request", description: "notify" }],
};

const purchaseState: StateDefinition = {
  name: "purchase_request_state",
  entity: "purchase_request",
  field: "status",
  initial: "draft",
  states: ["draft", "pending", "approved", "rejected"],
  transitions: [
    { from: "draft", to: "pending", action: "submit_request" },
    { from: "pending", to: "approved", action: "approve_request", guard: "budget_check" },
  ],
};

const budgetRule: RuleDefinition = {
  name: "budget_check",
  label: "Budget Check",
  trigger: { stateChange: { entity: "purchase_request", to: "pending" } },
  condition: { field: "amount", operator: "gt", value: 10000 },
  effect: { type: "require_approval" },
};

const requestListView: ViewDefinition = {
  name: "purchase_request_list",
  entity: "purchase_request",
  type: "list",
  fields: [{ field: "title" }, { field: "status" }],
};

const purchaseFlow: FlowDefinition = {
  name: "purchase_approval_flow",
  label: "Purchase Approval",
  trigger: { type: "event", eventType: "purchase_request.submit_request.succeeded" },
  steps: [{ id: "approve", type: "action", actionName: "approve_request" }],
};

const departmentRelation: RelationDefinition = {
  name: "request_department",
  from: "purchase_request",
  to: "department",
  cardinality: "many_to_one",
  fromName: "department",
  toName: "purchase_requests",
};

function makeRegistry(
  overrides: Partial<OntologyRegistryDeps> = {},
): ReturnType<typeof createOntologyRegistry> {
  const deps: OntologyRegistryDeps = {
    schemas: {
      getAll: () => [purchaseRequestEntity, departmentEntity, auditLogEntity],
      get: (name) =>
        [purchaseRequestEntity, departmentEntity, auditLogEntity].find((e) => e.name === name),
      has: (name) =>
        [purchaseRequestEntity, departmentEntity, auditLogEntity].some((e) => e.name === name),
    },
    actions: {
      getAll: () => [submitAction, approveAction],
    },
    rules: [budgetRule],
    states: [purchaseState],
    views: [requestListView],
    flows: { getAll: () => [purchaseFlow] },
    relationDefs: [departmentRelation],
    ...overrides,
  };
  return createOntologyRegistry(deps);
}

// ── inferEntitySemantics ──────────────────────────────────────────────────────

describe("inferEntitySemantics", () => {
  test("entity with state machine → transaction", () => {
    const sem = inferEntitySemantics(purchaseRequestEntity, [submitAction], purchaseState);
    expect(sem.category).toBe("transaction");
  });

  test("entity with no actions → reference", () => {
    const sem = inferEntitySemantics(departmentEntity, [], undefined);
    expect(sem.category).toBe("reference");
  });

  test("entity name ending in _log → log", () => {
    const sem = inferEntitySemantics(auditLogEntity, [], undefined);
    expect(sem.category).toBe("log");
  });

  test("entity with actions but no state → master_data", () => {
    const plain: EntityDefinition = {
      name: "product",
      fields: { name: { type: "string" } },
    };
    const action: ActionDefinition = {
      name: "create_product",
      entity: "product",
      label: "Create",
      policy: { mode: "sync", transaction: true },
    };
    const sem = inferEntitySemantics(plain, [action], undefined);
    expect(sem.category).toBe("master_data");
  });

  test("explicit semantics override inferred", () => {
    const entity: EntityDefinition = {
      name: "purchase_request",
      fields: {},
      semantics: { category: "config", domain: ["procurement"] },
    };
    const sem = inferEntitySemantics(entity, [submitAction], purchaseState);
    // Explicit wins over inferred 'transaction'
    expect(sem.category).toBe("config");
    expect(sem.domain).toEqual(["procurement"]);
  });
});

// ── inferActionSemantics ──────────────────────────────────────────────────────

describe("inferActionSemantics", () => {
  test("action with sideEffects → cross_entity", () => {
    const sem = inferActionSemantics(approveAction);
    expect(sem.sideEffectLevel).toBe("cross_entity");
  });

  test("action with stateTransition only → local", () => {
    const sem = inferActionSemantics(submitAction);
    expect(sem.sideEffectLevel).toBe("local");
  });

  test("action with compensate policy → reversible", () => {
    const sem = inferActionSemantics(approveAction);
    expect(sem.reversible).toBe(true);
  });

  test("action without compensate policy → not reversible", () => {
    const sem = inferActionSemantics(submitAction);
    expect(sem.reversible).toBe(false);
  });

  test("explicit sideEffectLevel wins", () => {
    const action: ActionDefinition = {
      ...approveAction,
      semantics: { sideEffectLevel: "external" },
    };
    const sem = inferActionSemantics(action);
    expect(sem.sideEffectLevel).toBe("external");
  });
});

// ── extractDependencyEdges ────────────────────────────────────────────────────

describe("extractDependencyEdges", () => {
  const edges = extractDependencyEdges({
    entities: [purchaseRequestEntity, departmentEntity],
    actions: [submitAction, approveAction],
    rules: [budgetRule],
    states: [purchaseState],
    events: [],
    handlers: [],
    flows: [purchaseFlow],
    views: [requestListView],
    relations: [departmentRelation],
  });

  test("action references entity", () => {
    const e = edges.find(
      (e) =>
        e.from.type === "action" &&
        e.from.name === "submit_request" &&
        e.to.type === "entity" &&
        e.to.name === "purchase_request" &&
        e.type === "references",
    );
    expect(e).toBeDefined();
  });

  test("rule field_read → entity", () => {
    const e = edges.find(
      (e) =>
        e.from.type === "rule" &&
        e.from.name === "budget_check" &&
        e.to.type === "entity" &&
        e.to.name === "purchase_request" &&
        e.type === "field_read",
    );
    expect(e).toBeDefined();
  });

  test("state guards rule", () => {
    const e = edges.find(
      (e) =>
        e.from.type === "state" &&
        e.from.name === "purchase_request_state" &&
        e.to.type === "rule" &&
        e.to.name === "budget_check" &&
        e.type === "guards",
    );
    expect(e).toBeDefined();
  });

  test("flow contains action", () => {
    const e = edges.find(
      (e) =>
        e.from.type === "flow" &&
        e.from.name === "purchase_approval_flow" &&
        e.to.type === "action" &&
        e.to.name === "approve_request" &&
        e.type === "contains",
    );
    expect(e).toBeDefined();
  });

  test("view references entity", () => {
    const e = edges.find(
      (e) =>
        e.from.type === "view" &&
        e.from.name === "purchase_request_list" &&
        e.to.type === "entity" &&
        e.to.name === "purchase_request" &&
        e.type === "references",
    );
    expect(e).toBeDefined();
  });

  test("relation references both entities", () => {
    const from = edges.filter(
      (e) =>
        e.from.type === "relation" &&
        e.from.name === "request_department" &&
        e.type === "references",
    );
    const targets = new Set(from.map((e) => e.to.name));
    expect(targets.has("purchase_request")).toBe(true);
    expect(targets.has("department")).toBe(true);
  });
});

// ── bfsForward / bfsReverse ───────────────────────────────────────────────────

describe("bfsForward + bfsReverse", () => {
  const edges = extractDependencyEdges({
    entities: [purchaseRequestEntity, departmentEntity],
    actions: [submitAction],
    rules: [],
    states: [],
    events: [],
    handlers: [],
    flows: [],
    views: [],
    relations: [],
  });

  test("bfsForward from action reaches entity", () => {
    const root: MetaModelRef = { type: "action", name: "submit_request" };
    const { nodes } = bfsForward(root, edges);
    const names = nodes.map((n) => n.name);
    expect(names).toContain("submit_request");
    expect(names).toContain("purchase_request");
  });

  test("bfsReverse from entity shows who depends on it", () => {
    const entityRef: MetaModelRef = { type: "entity", name: "purchase_request" };
    const layers = bfsReverse(entityRef, edges);
    // layers[0] = root, layers[1] = direct dependents (actions that reference it)
    expect(layers[0]).toEqual([entityRef]);
    const dependentNames = layers[1]?.map((r) => r.name) ?? [];
    expect(dependentNames).toContain("submit_request");
  });
});

// ── OntologyRegistry — semantic search API ────────────────────────────────────

describe("OntologyRegistry.searchByIntent", () => {
  test("returns matching elements by intent tag", () => {
    const entity: EntityDefinition = {
      name: "invoice",
      fields: { amount: { type: "number" } },
      semantics: { intent: ["financial_control", "compliance"] },
    };
    const registry = createOntologyRegistry({
      schemas: {
        getAll: () => [entity],
        get: (n) => (n === "invoice" ? entity : undefined),
        has: (n) => n === "invoice",
      },
      actions: { getAll: () => [] },
      rules: [],
      states: [],
      views: [],
    });

    const results = registry.searchByIntent("financial_control");
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.name === "invoice" && r.type === "entity")).toBe(true);
  });

  test("returns empty array for unknown intent", () => {
    const registry = makeRegistry();
    const results = registry.searchByIntent("unknown_intent_xyz");
    expect(results).toEqual([]);
  });
});

describe("OntologyRegistry.searchByDomain", () => {
  test("returns elements with matching domain", () => {
    const rule: RuleDefinition = {
      name: "compliance_rule",
      label: "Compliance",
      trigger: { stateChange: { entity: "purchase_request", to: "approved" } },
      condition: { field: "amount", operator: "gt", value: 0 },
      effect: { type: "block" },
      semantics: { domain: ["procurement", "compliance"] },
    };
    const registry = createOntologyRegistry({
      schemas: {
        getAll: () => [purchaseRequestEntity],
        get: (n) => (n === "purchase_request" ? purchaseRequestEntity : undefined),
        has: (n) => n === "purchase_request",
      },
      actions: { getAll: () => [] },
      rules: [rule],
      states: [],
      views: [],
    });

    const results = registry.searchByDomain("procurement");
    expect(results.some((r) => r.name === "compliance_rule")).toBe(true);
  });
});

describe("OntologyRegistry.getSemanticsFor", () => {
  const registry = makeRegistry();

  test("returns semantics for entity with state → transaction", () => {
    const sem = registry.getSemanticsFor({ type: "entity", name: "purchase_request" });
    expect(sem).toBeDefined();
    expect((sem as { category?: string }).category).toBe("transaction");
  });

  test("returns semantics for entity without actions → reference", () => {
    const sem = registry.getSemanticsFor({ type: "entity", name: "department" });
    expect(sem).toBeDefined();
  });

  test("returns undefined for unknown ref", () => {
    const sem = registry.getSemanticsFor({ type: "entity", name: "nonexistent" });
    expect(sem).toBeUndefined();
  });

  test("returns semantics for action", () => {
    const sem = registry.getSemanticsFor({ type: "action", name: "submit_request" });
    expect(sem).toBeDefined();
    expect((sem as { sideEffectLevel?: string }).sideEffectLevel).toBeDefined();
  });

  test("returns semantics for rule", () => {
    const sem = registry.getSemanticsFor({ type: "rule", name: "budget_check" });
    expect(sem).toBeDefined();
  });
});

// ── OntologyRegistry — dependency DAG API ────────────────────────────────────

describe("OntologyRegistry.dependencyGraph", () => {
  const registry = makeRegistry();

  test("returns graph rooted at given element", () => {
    const ref: MetaModelRef = { type: "action", name: "submit_request" };
    const graph = registry.dependencyGraph(ref);
    expect(graph.root).toEqual(ref);
    expect(graph.nodes.some((n) => n.name === "purchase_request")).toBe(true);
  });

  test("view → entity edge present", () => {
    const ref: MetaModelRef = { type: "view", name: "purchase_request_list" };
    const graph = registry.dependencyGraph(ref);
    expect(graph.nodes.some((n) => n.name === "purchase_request")).toBe(true);
    expect(graph.edges.some((e) => e.type === "references")).toBe(true);
  });
});

describe("OntologyRegistry.impactAnalysis", () => {
  const registry = makeRegistry();

  test("entity impact includes dependent actions", () => {
    const ref: MetaModelRef = { type: "entity", name: "purchase_request" };
    const layers = registry.impactAnalysis(ref);
    expect(layers[0]).toEqual([ref]);
    const allDependents = layers.flat();
    const dependentNames = allDependents.map((r) => r.name);
    // Actions, views, rules, state, relation all depend on purchase_request
    expect(dependentNames.some((n) => ["submit_request", "approve_request"].includes(n))).toBe(
      true,
    );
  });

  test("returns only root layer for isolated element", () => {
    const isolated: EntityDefinition = {
      name: "isolated_entity",
      fields: {},
    };
    const registry2 = createOntologyRegistry({
      schemas: {
        getAll: () => [isolated],
        get: (n) => (n === "isolated_entity" ? isolated : undefined),
        has: (n) => n === "isolated_entity",
      },
      actions: { getAll: () => [] },
      rules: [],
      states: [],
      views: [],
    });

    const ref: MetaModelRef = { type: "entity", name: "isolated_entity" };
    const layers = registry2.impactAnalysis(ref);
    expect(layers.length).toBe(1); // only root, no dependents
    expect(layers[0]).toEqual([ref]);
  });
});
