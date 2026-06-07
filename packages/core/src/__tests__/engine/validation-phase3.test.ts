/**
 * Validation Phase 3 (compatibility / breaking-reference) tests — Spec 09 §4.5
 *
 * Covers both the standalone `validatePhase3` and its integration through
 * `validateProposal`, asserting the warn-only default and the gated escalation
 * to block via `strictCompatibility`.
 */

import { describe, expect, test } from "bun:test";
import { validateProposal } from "../../engine/validation-engine";
import { validatePhase3 } from "../../engine/validation-phase3";
import { createOntologyRegistry, type OntologyRegistryDeps } from "../../ontology";
import type { ActionDefinition } from "../../types/action";
import type { EntityDefinition } from "../../types/entity";
import type { ProposalChange, ProposalDefinition } from "../../types/proposal";
import type { RuleDefinition } from "../../types/rule";
import type { StateDefinition } from "../../types/state";
import type { ViewDefinition } from "../../types/view";

// ── Current (pre-change) meta-model ──────────────────────

const orderEntity: EntityDefinition = {
  name: "order",
  label: "Order",
  fields: {
    title: { type: "string", label: "Title", required: true },
    amount: { type: "number", label: "Amount" },
    priority: {
      type: "enum",
      label: "Priority",
      options: [{ value: "low" }, { value: "high" }],
    },
    status: { type: "state", label: "Status", machine: "order_state" },
    note: { type: "string", label: "Note" },
  },
};

const approveAction: ActionDefinition = {
  name: "approve_order",
  entity: "order",
  label: "Approve Order",
  policy: { mode: "sync", transaction: true },
} as unknown as ActionDefinition;

// Rule whose condition reads order.amount, triggered by the action.
const amountRule: RuleDefinition = {
  name: "amount_check",
  label: "Amount Check",
  trigger: { action: "approve_order" },
  condition: { field: "amount", operator: "gt", value: 100 },
  effect: { type: "warn", message: "Large order" },
};

// Rule triggered by a fieldChange on order.priority.
const priorityRule: RuleDefinition = {
  name: "priority_watch",
  label: "Priority Watch",
  trigger: { fieldChange: { entity: "order", field: "priority" } },
  condition: { field: "priority", operator: "eq", value: "high" },
  effect: { type: "warn", message: "High priority" },
};

// Rule whose effect triggers approve_order — creates a rule→triggers→action
// DAG edge so deleting the action has a detectable dependent.
const autoApproveRule: RuleDefinition = {
  name: "auto_approve",
  label: "Auto Approve",
  trigger: { fieldChange: { entity: "order", field: "amount" } },
  condition: { field: "amount", operator: "lt", value: 10 },
  effect: { type: "execute_action", action: "approve_order" },
};

const orderState: StateDefinition = {
  name: "order_state",
  entity: "order",
  field: "status",
  initial: "draft",
  states: ["draft", "approved"],
  transitions: [{ from: "draft", to: "approved", action: "approve_order" }],
};

const orderListView: ViewDefinition = {
  name: "order_list",
  entity: "order",
  type: "list",
  label: "Orders",
  fields: [{ field: "title" }, { field: "amount" }, { field: "priority" }],
};

// ── OntologyRegistry test helpers ────────────────────────

function createMockEntityRegistry(entities: EntityDefinition[]) {
  const map = new Map(entities.map((e) => [e.name, e]));
  return {
    getAll: () => entities,
    get: (name: string) => map.get(name),
    has: (name: string) => map.has(name),
  };
}

function buildOntology(overrides?: Partial<OntologyRegistryDeps>) {
  const deps: OntologyRegistryDeps = {
    schemas: createMockEntityRegistry([orderEntity]),
    actions: { getAll: () => [approveAction] },
    rules: [amountRule, priorityRule, autoApproveRule],
    states: [orderState],
    views: [orderListView],
    ...overrides,
  };
  return createOntologyRegistry(deps);
}

// ── Change builders ──────────────────────────────────────

/** Entity delete change retaining only the given fields (the rest are removed). */
function entityDeleteRetaining(fields: string[]): ProposalChange {
  const def: EntityDefinition = {
    name: "order",
    fields: Object.fromEntries(fields.map((f) => [f, orderEntity.fields[f] ?? { type: "string" }])),
  };
  return { target: "entity", operation: "delete", name: "order", definition: def };
}

/** Entity update change with the full new field set. */
function entityUpdate(fields: EntityDefinition["fields"]): ProposalChange {
  return {
    target: "entity",
    operation: "update",
    name: "order",
    definition: { name: "order", fields },
  };
}

function makeProposal(changes: ProposalChange[]): ProposalDefinition {
  const now = new Date();
  return {
    id: "p1",
    title: "Test proposal",
    description: "",
    author: { type: "human", id: "u1", name: "Tester" },
    capability: "demo",
    changeType: "major",
    changes,
    impact: {
      schemasAffected: [],
      actionsAffected: [],
      rulesAffected: [],
      dependentsAffected: [],
      migrationRequired: false,
    },
    status: "draft",
    createdAt: now,
    updatedAt: now,
  };
}

// ── validatePhase3: skipped without ontology ─────────────

describe("validatePhase3 — degradation", () => {
  test("returns skipped when no ontology is provided", () => {
    const result = validatePhase3({
      changes: [entityDeleteRetaining(["title"])],
    });
    expect(result.phase).toBe(3);
    expect(result.status).toBe("skipped");
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  test("does not throw when the entity is unknown to the ontology", () => {
    const ontology = buildOntology();
    const result = validatePhase3({
      changes: [{ target: "entity", operation: "delete", name: "unknown_entity" }],
      ontology,
    });
    expect(result.status).toBe("passed");
    expect(result.warnings).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });
});

// ── Field-delete breakage ────────────────────────────────

describe("validatePhase3 — field deletion", () => {
  test("deleting a field referenced by a view + rule warns by default", () => {
    const ontology = buildOntology();
    // Drop `amount` (referenced by order_list view AND amount_check rule).
    const result = validatePhase3({
      changes: [entityDeleteRetaining(["title", "priority", "status", "note"])],
      ontology,
    });
    expect(result.status).toBe("passed"); // warn-only
    expect(result.errors).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThanOrEqual(2);
    const codes = result.warnings.map((w) => w.code);
    expect(codes).toContain("BREAKING_FIELD_DELETE");
    const targets = result.warnings.map((w) => w.field);
    expect(targets).toContain("amount");
  });

  test("strictCompatibility escalates field-delete to a blocking error", () => {
    const ontology = buildOntology();
    const result = validatePhase3({
      changes: [entityDeleteRetaining(["title", "priority", "status", "note"])],
      ontology,
      strictCompatibility: true,
    });
    expect(result.status).toBe("failed");
    expect(result.warnings).toHaveLength(0);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
    expect(result.errors.map((e) => e.code)).toContain("BREAKING_FIELD_DELETE");
  });

  test("deleting a field referenced by a fieldChange-trigger rule warns", () => {
    const ontology = buildOntology();
    // Drop `priority` (referenced by priority_watch rule trigger + condition,
    // and the order_list view).
    const result = validatePhase3({
      changes: [entityDeleteRetaining(["title", "amount", "status", "note"])],
      ontology,
    });
    const priorityFindings = result.warnings.filter((w) => w.field === "priority");
    expect(priorityFindings.length).toBeGreaterThanOrEqual(1);
  });

  test("deleting an unreferenced field produces no findings", () => {
    const ontology = buildOntology();
    // Drop `note` only (referenced by nothing).
    const result = validatePhase3({
      changes: [entityDeleteRetaining(["title", "amount", "priority", "status"])],
      ontology,
    });
    expect(result.status).toBe("passed");
    expect(result.warnings).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });
});

// ── Element delete via impact graph ──────────────────────

describe("validatePhase3 — action/state deletion", () => {
  test("deleting an action that a rule + state depend on warns", () => {
    const ontology = buildOntology();
    const result = validatePhase3({
      changes: [{ target: "action", operation: "delete", name: "approve_order" }],
      ontology,
    });
    expect(result.status).toBe("passed");
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
    expect(result.warnings.map((w) => w.code)).toContain("BREAKING_ELEMENT_DELETE");
  });

  test("deleting a state machine that nothing depends on produces no findings", () => {
    const ontology = buildOntology();
    const result = validatePhase3({
      changes: [{ target: "state", operation: "delete", name: "order_state" }],
      ontology,
    });
    // Nothing in the DAG points TO state:order_state, so no breakage.
    expect(result.status).toBe("passed");
    expect(result.warnings).toHaveLength(0);
  });

  test("deleting a whole entity flags entity-level dependents (not just fields)", () => {
    const ontology = buildOntology();
    // Whole-entity delete: no surviving `definition`, so the entity itself —
    // referenced by actions/views/states — must be flagged via the impact graph.
    const result = validatePhase3({
      changes: [{ target: "entity", operation: "delete", name: "order" }],
      ontology,
    });
    expect(result.warnings.map((w) => w.code)).toContain("BREAKING_ELEMENT_DELETE");
  });
});

// ── Update narrowing ─────────────────────────────────────

describe("validatePhase3 — update narrowing", () => {
  test("changing a field's type is breaking", () => {
    const ontology = buildOntology();
    const result = validatePhase3({
      changes: [
        entityUpdate({
          ...orderEntity.fields,
          amount: { type: "string", label: "Amount" }, // number → string
        }),
      ],
      ontology,
    });
    expect(result.warnings.map((w) => w.code)).toContain("BREAKING_FIELD_TYPE_CHANGE");
    expect(result.warnings.find((w) => w.field === "amount")).toBeDefined();
  });

  test("removing an enum value is breaking", () => {
    const ontology = buildOntology();
    const result = validatePhase3({
      changes: [
        entityUpdate({
          ...orderEntity.fields,
          priority: { type: "enum", label: "Priority", options: [{ value: "low" }] }, // drop "high"
        }),
      ],
      ontology,
    });
    const codes = result.warnings.map((w) => w.code);
    expect(codes).toContain("BREAKING_ENUM_VALUE_REMOVED");
  });

  test("dropping the default of a previously-required field is breaking", () => {
    const ontology = buildOntology({
      schemas: createMockEntityRegistry([
        {
          name: "order",
          fields: {
            title: { type: "string", required: true, default: "untitled" },
          },
        },
      ]),
    });
    const result = validatePhase3({
      changes: [entityUpdate({ title: { type: "string", required: true } })],
      ontology,
    });
    expect(result.warnings.map((w) => w.code)).toContain("BREAKING_REQUIRED_DEFAULT_DROP");
  });

  test("making a required field optional and dropping its default is NOT breaking", () => {
    const ontology = buildOntology({
      schemas: createMockEntityRegistry([
        {
          name: "order",
          fields: {
            title: { type: "string", required: true, default: "untitled" },
          },
        },
      ]),
    });
    // required+default → optional, default removed. This is a loosening change,
    // so it must NOT be flagged (and must not block under strictCompatibility).
    const result = validatePhase3({
      changes: [entityUpdate({ title: { type: "string", required: false } })],
      ontology,
      strictCompatibility: true,
    });
    expect(result.errors.map((e) => e.code)).not.toContain("BREAKING_REQUIRED_DEFAULT_DROP");
    expect(result.warnings.map((w) => w.code)).not.toContain("BREAKING_REQUIRED_DEFAULT_DROP");
  });

  test("adding an optional field is not breaking", () => {
    const ontology = buildOntology();
    const result = validatePhase3({
      changes: [
        entityUpdate({
          ...orderEntity.fields,
          tags: { type: "string", label: "Tags", required: false },
        }),
      ],
      ontology,
    });
    expect(result.status).toBe("passed");
    expect(result.warnings).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });
});

// ── Integration via validateProposal ─────────────────────

// A Phase-1-clean entity update that nonetheless narrows `amount` (number →
// string). Keeping Phase 1 green isolates Phase 3 as the only failing signal,
// so these tests assert Phase 3's effect on `passed` rather than Phase 1's.
function cleanBreakingAmountUpdate(): ProposalChange {
  return entityUpdate({
    title: { type: "string", label: "Title", required: true, default: "untitled" },
    amount: { type: "string", label: "Amount" }, // breaking type change vs. number
    priority: {
      type: "enum",
      label: "Priority",
      options: [{ value: "low" }, { value: "high" }],
    },
    status: { type: "state", label: "Status", machine: "order_state" },
    note: { type: "string", label: "Note" },
  });
}

describe("validateProposal — Phase 3 integration", () => {
  test("breaking field type change warns but passed stays true by default", () => {
    const ontology = buildOntology();
    const proposal = makeProposal([cleanBreakingAmountUpdate()]);
    const result = validateProposal({ proposal, context: { ontology } });
    expect(result.passed).toBe(true);
    const phase1 = result.phases.find((p) => p.phase === 1);
    expect(phase1?.status).toBe("passed"); // confirm Phase 1 is not the signal
    const phase3 = result.phases.find((p) => p.phase === 3);
    expect(phase3?.status).toBe("passed");
    expect(phase3?.warnings.length).toBeGreaterThanOrEqual(1);
  });

  test("strictCompatibility blocks (passed becomes false)", () => {
    const ontology = buildOntology();
    const proposal = makeProposal([cleanBreakingAmountUpdate()]);
    const result = validateProposal({
      proposal,
      context: { ontology, strictCompatibility: true },
    });
    expect(result.passed).toBe(false);
    const phase1 = result.phases.find((p) => p.phase === 1);
    expect(phase1?.status).toBe("passed"); // Phase 3 is the sole blocker
    const phase3 = result.phases.find((p) => p.phase === 3);
    expect(phase3?.status).toBe("failed");
    expect(phase3?.errors.length).toBeGreaterThanOrEqual(1);
  });

  test("without ontology in context, Phase 3 is skipped (unchanged behavior)", () => {
    const proposal = makeProposal([cleanBreakingAmountUpdate()]);
    const result = validateProposal({ proposal });
    expect(result.passed).toBe(true);
    const phase3 = result.phases.find((p) => p.phase === 3);
    expect(phase3?.status).toBe("skipped");
    expect(phase3?.warnings).toHaveLength(0);
    expect(phase3?.errors).toHaveLength(0);
  });

  test("non-breaking proposal with empty context behaves as before", () => {
    const proposal = makeProposal([
      {
        target: "entity",
        operation: "create",
        name: "widget",
        definition: {
          name: "widget",
          fields: { label: { type: "string", required: false } },
        },
      },
    ]);
    const result = validateProposal({ proposal });
    expect(result.passed).toBe(true);
    const phase3 = result.phases.find((p) => p.phase === 3);
    expect(phase3?.status).toBe("skipped");
  });
});
