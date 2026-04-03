import { describe, expect, it } from "bun:test";
import { validatePhase1, validateProposal } from "../src/engine/validation-engine";
import type { ActionDefinition } from "../src/types/action";
import type { ProposalChange } from "../src/types/proposal";
import type { RuleDefinition } from "../src/types/rule";
import type { EntityDefinition } from "../src/types/entity";
import type { StateDefinition } from "../src/types/state";

// ── Helpers ──────────────────────────────────────────────

function makeSchemaChange(name: string, def: Partial<EntityDefinition> = {}): ProposalChange {
  return {
    target: "schema",
    operation: "create",
    name,
    definition: {
      name,
      fields: { title: { type: "string", required: false } },
      ...def,
    } as EntityDefinition,
  };
}

function makeActionChange(name: string, def: Partial<ActionDefinition> = {}): ProposalChange {
  return {
    target: "action",
    operation: "create",
    name,
    definition: {
      name,
      schema: "order",
      label: "Test Action",
      policy: { execution: "immediate" },
      ...def,
    } as ActionDefinition,
  };
}

function makeStateChange(name: string, def: Partial<StateDefinition> = {}): ProposalChange {
  return {
    target: "state",
    operation: "create",
    name,
    definition: {
      name,
      schema: "order",
      field: "status",
      initial: "pending",
      states: ["pending", "active", "done"],
      transitions: [
        { from: "pending", to: "active", action: "activate" },
        { from: "active", to: "done", action: "complete" },
      ],
      ...def,
    } as StateDefinition,
  };
}

function makeRuleChange(name: string, def: Partial<RuleDefinition> = {}): ProposalChange {
  return {
    target: "rule",
    operation: "create",
    name,
    definition: {
      name,
      trigger: { action: "approve_order" },
      condition: { field: "amount", operator: "gt", value: 0 },
      effect: { type: "notify", config: {} },
      ...def,
    } as unknown as RuleDefinition,
  };
}

// ── validatePhase1 ───────────────────────────────────────

describe("validatePhase1", () => {
  describe("empty changes", () => {
    it("passes with empty changes array", () => {
      const result = validatePhase1({ changes: [] });
      expect(result.status).toBe("passed");
      expect(result.errors).toHaveLength(0);
      expect(result.phase).toBe(1);
    });
  });

  describe("naming convention", () => {
    it("rejects names starting with a digit", () => {
      const result = validatePhase1({ changes: [makeSchemaChange("1order")] });
      expect(result.status).toBe("failed");
      expect(result.errors.some((e) => e.code === "INVALID_NAME")).toBe(true);
    });

    it("rejects names with uppercase letters", () => {
      const result = validatePhase1({ changes: [makeSchemaChange("MySchema")] });
      expect(result.status).toBe("failed");
      expect(result.errors.some((e) => e.code === "INVALID_NAME")).toBe(true);
    });

    it("rejects names with hyphens", () => {
      const result = validatePhase1({ changes: [makeSchemaChange("my-schema")] });
      expect(result.status).toBe("failed");
      expect(result.errors.some((e) => e.code === "INVALID_NAME")).toBe(true);
    });

    it("accepts valid lowercase names with underscores", () => {
      const result = validatePhase1({ changes: [makeSchemaChange("my_schema")] });
      expect(result.status).toBe("passed");
    });

    it("accepts delete operations with invalid names (delete bypasses definition checks)", () => {
      const result = validatePhase1({
        changes: [{ target: "schema", operation: "delete", name: "MySchema" }],
      });
      // Name check still runs — delete does not skip name validation
      expect(result.errors.some((e) => e.code === "INVALID_NAME")).toBe(true);
    });
  });

  describe("duplicate changes", () => {
    it("errors when same name+target appears twice", () => {
      const result = validatePhase1({
        changes: [makeSchemaChange("order"), makeSchemaChange("order")],
      });
      expect(result.status).toBe("failed");
      expect(result.errors.some((e) => e.code === "DUPLICATE_CHANGE")).toBe(true);
    });

    it("allows same name with different targets", () => {
      const result = validatePhase1({
        changes: [makeSchemaChange("order"), makeActionChange("order")],
      });
      // No duplicate error — different targets
      expect(result.errors.filter((e) => e.code === "DUPLICATE_CHANGE")).toHaveLength(0);
    });
  });

  describe("schema validation", () => {
    it("errors on schema with no fields", () => {
      const result = validatePhase1({
        changes: [makeSchemaChange("empty_schema", { fields: {} })],
      });
      expect(result.status).toBe("failed");
      expect(result.errors.some((e) => e.code === "SCHEMA_NO_FIELDS")).toBe(true);
    });

    it("errors on invalid field type", () => {
      const result = validatePhase1({
        changes: [
          makeSchemaChange("bad_schema", {
            fields: { x: { type: "invalid_type" as never, required: false } },
          }),
        ],
      });
      expect(result.status).toBe("failed");
      expect(result.errors.some((e) => e.code === "INVALID_FIELD_TYPE")).toBe(true);
    });

    it("errors on enum field with no options", () => {
      const result = validatePhase1({
        changes: [
          makeSchemaChange("enum_schema", {
            fields: { status: { type: "enum", options: [], required: false } as never },
          }),
        ],
      });
      expect(result.status).toBe("failed");
      expect(result.errors.some((e) => e.code === "ENUM_NO_OPTIONS")).toBe(true);
    });

    it("accepts enum field with options", () => {
      const result = validatePhase1({
        changes: [
          makeSchemaChange("enum_schema", {
            fields: {
              status: {
                type: "enum",
                options: [{ value: "a", label: "A" }],
                required: false,
              } as never,
            },
          }),
        ],
      });
      expect(result.errors.filter((e) => e.code === "ENUM_NO_OPTIONS")).toHaveLength(0);
    });

    it("errors on state field with no machine reference", () => {
      const result = validatePhase1({
        changes: [
          makeSchemaChange("state_schema", {
            fields: { status: { type: "state", required: false } as never },
          }),
        ],
      });
      expect(result.status).toBe("failed");
      expect(result.errors.some((e) => e.code === "STATE_NO_MACHINE")).toBe(true);
    });

    it("errors on required field without default (non-virtual)", () => {
      const result = validatePhase1({
        changes: [
          makeSchemaChange("req_schema", {
            fields: { title: { type: "string", required: true } },
          }),
        ],
      });
      expect(result.status).toBe("failed");
      expect(result.errors.some((e) => e.code === "REQUIRED_NO_DEFAULT")).toBe(true);
    });

    it("does not error on required virtual fields (ref, has_many, computed)", () => {
      const result = validatePhase1({
        changes: [
          makeSchemaChange("virtual_schema", {
            fields: {
              items: { type: "has_many", required: true } as never,
              parent: { type: "ref", required: true } as never,
            },
          }),
        ],
      });
      expect(result.errors.filter((e) => e.code === "REQUIRED_NO_DEFAULT")).toHaveLength(0);
    });
  });

  describe("missing definition on create/update", () => {
    it("errors when definition is missing for create", () => {
      const result = validatePhase1({
        changes: [{ target: "schema", operation: "create", name: "broken" }],
      });
      expect(result.status).toBe("failed");
      expect(result.errors.some((e) => e.code === "MISSING_DEFINITION")).toBe(true);
    });
  });

  describe("action validation", () => {
    it("errors on action with no schema", () => {
      const result = validatePhase1({
        changes: [makeActionChange("my_action", { schema: undefined as never })],
      });
      expect(result.errors.some((e) => e.code === "ACTION_NO_SCHEMA")).toBe(true);
    });

    it("warns on action referencing unknown schema", () => {
      const result = validatePhase1({
        changes: [makeActionChange("my_action", { schema: "nonexistent_schema" })],
      });
      expect(result.warnings.some((w) => w.code === "ACTION_UNKNOWN_SCHEMA")).toBe(true);
    });

    it("does not warn when schema is in the same proposal", () => {
      const result = validatePhase1({
        changes: [makeSchemaChange("order"), makeActionChange("place_order", { schema: "order" })],
      });
      expect(result.warnings.filter((w) => w.code === "ACTION_UNKNOWN_SCHEMA")).toHaveLength(0);
    });

    it("errors on action with no policy", () => {
      const result = validatePhase1({
        changes: [makeActionChange("my_action", { policy: undefined as never })],
      });
      expect(result.errors.some((e) => e.code === "ACTION_NO_POLICY")).toBe(true);
    });

    it("warns on action with no label", () => {
      const result = validatePhase1({
        changes: [makeActionChange("my_action", { label: undefined as never })],
      });
      expect(result.warnings.some((w) => w.code === "ACTION_NO_LABEL")).toBe(true);
    });

    it("warns on action with no handler", () => {
      const result = validatePhase1({
        changes: [makeActionChange("my_action", { handler: undefined })],
      });
      expect(result.warnings.some((w) => w.code === "ACTION_NO_HANDLER")).toBe(true);
    });

    it("errors on state transition with no from", () => {
      const result = validatePhase1({
        changes: [
          makeActionChange("approve", {
            schema: "order",
            stateTransition: { from: undefined as never, to: "approved" },
          }),
        ],
      });
      expect(result.errors.some((e) => e.code === "TRANSITION_NO_FROM")).toBe(true);
    });

    it("errors on state transition with no to", () => {
      const result = validatePhase1({
        changes: [
          makeActionChange("approve", {
            schema: "order",
            stateTransition: { from: "pending", to: undefined as never },
          }),
        ],
      });
      expect(result.errors.some((e) => e.code === "TRANSITION_NO_TO")).toBe(true);
    });

    it("validates transition states against state machine in same proposal", () => {
      const result = validatePhase1({
        changes: [
          makeStateChange("order_status", {
            schema: "order",
            states: ["pending", "active"],
            initial: "pending",
            transitions: [{ from: "pending", to: "active", action: "activate" }],
          }),
          makeActionChange("bad_action", {
            schema: "order",
            stateTransition: { from: "nonexistent", to: "active" },
          }),
        ],
      });
      expect(result.errors.some((e) => e.code === "TRANSITION_INVALID_STATE")).toBe(true);
    });
  });

  describe("rule validation", () => {
    it("errors on rule with no trigger", () => {
      const result = validatePhase1({
        changes: [makeRuleChange("my_rule", { trigger: undefined as never })],
      });
      expect(result.errors.some((e) => e.code === "RULE_NO_TRIGGER")).toBe(true);
    });

    it("errors on rule with no condition", () => {
      const result = validatePhase1({
        changes: [makeRuleChange("my_rule", { condition: undefined as never })],
      });
      expect(result.errors.some((e) => e.code === "RULE_NO_CONDITION")).toBe(true);
    });

    it("errors on rule with no effect", () => {
      const result = validatePhase1({
        changes: [makeRuleChange("my_rule", { effect: undefined as never })],
      });
      expect(result.errors.some((e) => e.code === "RULE_NO_EFFECT")).toBe(true);
    });

    it("warns on rule referencing unknown action", () => {
      const result = validatePhase1({
        changes: [makeRuleChange("my_rule", { trigger: { action: "unknown_action" } as never })],
      });
      expect(result.warnings.some((w) => w.code === "RULE_UNKNOWN_ACTION")).toBe(true);
    });

    it("does not warn when trigger action is in same proposal", () => {
      const result = validatePhase1({
        changes: [
          makeActionChange("approve_order"),
          makeRuleChange("my_rule", { trigger: { action: "approve_order" } as never }),
        ],
      });
      expect(result.warnings.filter((w) => w.code === "RULE_UNKNOWN_ACTION")).toHaveLength(0);
    });
  });

  describe("state definition validation", () => {
    it("errors on state def with no states", () => {
      const result = validatePhase1({
        changes: [makeStateChange("empty_sm", { states: [] })],
      });
      expect(result.errors.some((e) => e.code === "STATE_NO_STATES")).toBe(true);
    });

    it("errors when initial state is not in states list", () => {
      const result = validatePhase1({
        changes: [
          makeStateChange("bad_sm", {
            states: ["active", "done"],
            initial: "nonexistent" as never,
            transitions: [],
          }),
        ],
      });
      expect(result.errors.some((e) => e.code === "STATE_INVALID_INITIAL")).toBe(true);
    });

    it("errors when transition references unknown state", () => {
      const result = validatePhase1({
        changes: [
          makeStateChange("bad_trans_sm", {
            states: ["pending", "done"],
            initial: "pending",
            transitions: [{ from: "pending", to: "ghost", action: "finish" }],
          }),
        ],
      });
      expect(result.errors.some((e) => e.code === "STATE_INVALID_TRANSITION_TO")).toBe(true);
    });

    it("warns on unreachable state", () => {
      const result = validatePhase1({
        changes: [
          makeStateChange("isolated_state_sm", {
            states: ["pending", "done", "orphan"],
            initial: "pending",
            transitions: [{ from: "pending", to: "done", action: "finish" }],
          }),
        ],
      });
      expect(result.warnings.some((w) => w.code === "STATE_UNREACHABLE")).toBe(true);
    });

    it("warns on dead-end state", () => {
      const result = validatePhase1({
        changes: [
          makeStateChange("dead_end_sm", {
            states: ["pending", "done"],
            initial: "pending",
            transitions: [{ from: "pending", to: "done", action: "finish" }],
          }),
        ],
      });
      // "done" is reachable with incoming but no outgoing — dead end
      expect(result.warnings.some((w) => w.code === "STATE_DEAD_END")).toBe(true);
    });
  });
});

// ── validateProposal ─────────────────────────────────────

describe("validateProposal", () => {
  it("returns passed for a valid proposal", () => {
    const result = validateProposal({
      proposal: {
        id: "p-1",
        title: "Test Proposal",
        status: "draft",
        changes: [makeSchemaChange("valid_schema")],
        author: { type: "human", id: "u1", name: "Alice" },
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never,
    });
    expect(result.passed).toBe(true);
    expect(result.phases[0].status).toBe("passed");
    // Phases 2-4 are skipped
    expect(result.phases[1].status).toBe("skipped");
  });

  it("returns failed and includes impact summary for invalid proposal", () => {
    const result = validateProposal({
      proposal: {
        id: "p-2",
        title: "Bad Proposal",
        status: "draft",
        changes: [makeSchemaChange("bad_schema", { fields: {} })],
        author: { type: "human", id: "u1", name: "Alice" },
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never,
    });
    expect(result.passed).toBe(false);
    expect(result.impactSummary).toContain("change");
  });
});
