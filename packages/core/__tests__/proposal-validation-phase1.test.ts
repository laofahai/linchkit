import { describe, expect, it } from "bun:test";
import { validatePhase1 } from "../src/server-entry";

// ── validatePhase1 ──────────────────────────────────────

describe("validatePhase1", () => {
  it("passes for valid schema changes", () => {
    const result = validatePhase1({
      changes: [
        {
          target: "entity",
          operation: "create",
          name: "order",
          definition: {
            name: "order",
            fields: {
              title: { type: "string", label: "Title" },
              amount: { type: "number", label: "Amount" },
            },
          },
        },
      ],
    });

    expect(result.status).toBe("passed");
    expect(result.errors).toHaveLength(0);
  });

  it("fails for schema with no fields", () => {
    const result = validatePhase1({
      changes: [
        {
          target: "entity",
          operation: "create",
          name: "empty",
          definition: {
            name: "empty",
            fields: {},
          },
        },
      ],
    });

    expect(result.status).toBe("failed");
    expect(result.errors.some((e) => e.code === "ENTITY_NO_FIELDS")).toBe(true);
  });

  it("fails for invalid field types", () => {
    const result = validatePhase1({
      changes: [
        {
          target: "entity",
          operation: "create",
          name: "bad_types",
          definition: {
            name: "bad_types",
            fields: {
              // @ts-expect-error Testing invalid type
              weird: { type: "spaceship", label: "Weird" },
            },
          },
        },
      ],
    });

    expect(result.status).toBe("failed");
    expect(result.errors.some((e) => e.code === "INVALID_FIELD_TYPE")).toBe(true);
  });

  it("fails for enum field without options", () => {
    const result = validatePhase1({
      changes: [
        {
          target: "entity",
          operation: "create",
          name: "bad_enum",
          definition: {
            name: "bad_enum",
            fields: {
              // @ts-expect-error Testing missing options
              status: { type: "enum", label: "Status" },
            },
          },
        },
      ],
    });

    expect(result.status).toBe("failed");
    expect(result.errors.some((e) => e.code === "ENUM_NO_OPTIONS")).toBe(true);
  });

  it("fails for invalid name format", () => {
    const result = validatePhase1({
      changes: [
        {
          target: "entity",
          operation: "create",
          name: "BadName",
          definition: {
            name: "BadName",
            fields: { x: { type: "string", label: "X" } },
          },
        },
      ],
    });

    expect(result.status).toBe("failed");
    expect(result.errors.some((e) => e.code === "INVALID_NAME")).toBe(true);
  });

  it("validates action changes", () => {
    const result = validatePhase1({
      changes: [
        {
          target: "entity",
          operation: "create",
          name: "order",
          definition: {
            name: "order",
            fields: { title: { type: "string", label: "Title" } },
          },
        },
        {
          target: "action",
          operation: "create",
          name: "create_order",
          definition: {
            name: "create_order",
            entity: "order",
            label: "Create Order",
            policy: { mode: "sync", transaction: true },
          },
        },
      ],
    });

    expect(result.status).toBe("passed");
    expect(result.errors).toHaveLength(0);
  });

  it("fails for action without schema", () => {
    const result = validatePhase1({
      changes: [
        {
          target: "action",
          operation: "create",
          name: "bad_action",
          definition: {
            name: "bad_action",
            entity: "",
            label: "Bad",
            policy: { mode: "sync", transaction: false },
          },
        },
      ],
    });

    expect(result.status).toBe("failed");
    expect(result.errors.some((e) => e.code === "ACTION_NO_ENTITY")).toBe(true);
  });

  it("validates state definition changes", () => {
    const result = validatePhase1({
      changes: [
        {
          target: "entity",
          operation: "create",
          name: "order",
          definition: {
            name: "order",
            fields: { title: { type: "string", label: "Title" } },
          },
        },
        {
          target: "state",
          operation: "create",
          name: "order_lifecycle",
          definition: {
            name: "order_lifecycle",
            entity: "order",
            field: "status",
            initial: "draft",
            states: ["draft", "submitted", "approved"],
            transitions: [
              { from: "draft", to: "submitted", action: "submit" },
              { from: "submitted", to: "approved", action: "approve" },
            ],
          },
        },
      ],
    });

    expect(result.status).toBe("passed");
  });

  it("fails for state definition with invalid initial state", () => {
    const result = validatePhase1({
      changes: [
        {
          target: "state",
          operation: "create",
          name: "bad_state",
          definition: {
            name: "bad_state",
            entity: "order",
            field: "status",
            initial: "nonexistent",
            states: ["draft", "submitted"],
            transitions: [],
          },
        },
      ],
    });

    expect(result.status).toBe("failed");
    expect(result.errors.some((e) => e.code === "STATE_INVALID_INITIAL")).toBe(true);
  });

  it("warns about unreachable states", () => {
    const result = validatePhase1({
      changes: [
        {
          target: "entity",
          operation: "create",
          name: "order",
          definition: {
            name: "order",
            fields: { title: { type: "string", label: "Title" } },
          },
        },
        {
          target: "state",
          operation: "create",
          name: "order_lifecycle",
          definition: {
            name: "order_lifecycle",
            entity: "order",
            field: "status",
            initial: "draft",
            states: ["draft", "submitted", "orphan"],
            transitions: [{ from: "draft", to: "submitted", action: "submit" }],
          },
        },
      ],
    });

    expect(result.warnings.some((w) => w.code === "STATE_UNREACHABLE")).toBe(true);
  });

  it("validates rule changes", () => {
    const result = validatePhase1({
      changes: [
        {
          target: "action",
          operation: "create",
          name: "submit_order",
          definition: {
            name: "submit_order",
            entity: "order",
            label: "Submit Order",
            policy: { mode: "sync", transaction: true },
          },
        },
        {
          target: "rule",
          operation: "create",
          name: "check_amount",
          definition: {
            name: "check_amount",
            label: "Check Amount",
            trigger: { action: "submit_order" },
            condition: { field: "amount", operator: "gt", value: 10000 },
            effect: { type: "block", message: "Amount too high" },
          },
        },
      ],
    });

    expect(result.status).toBe("passed");
  });

  it("skips validation for delete operations", () => {
    const result = validatePhase1({
      changes: [
        {
          target: "entity",
          operation: "delete",
          name: "old_schema",
        },
      ],
    });

    expect(result.status).toBe("passed");
    expect(result.errors).toHaveLength(0);
  });

  it("fails for missing definition on create", () => {
    const result = validatePhase1({
      changes: [
        {
          target: "entity",
          operation: "create",
          name: "no_def",
        },
      ],
    });

    expect(result.status).toBe("failed");
    expect(result.errors.some((e) => e.code === "MISSING_DEFINITION")).toBe(true);
  });

  it('passes a target:"revert" change despite having no definition (Spec 55 §7.7)', () => {
    // A rollback Proposal carries a single definition-less revert change with a
    // fixed, NAME_PATTERN-valid name. Phase-1 must NOT flag MISSING_DEFINITION
    // or INVALID_NAME for it, or the draft can never reach the approval gate.
    const result = validatePhase1({
      changes: [
        {
          target: "revert",
          operation: "update",
          name: "revert",
          diff: 'Roll back merged proposal "proposal_abc".',
        },
      ],
    });

    expect(result.status).toBe("passed");
    expect(result.errors).toHaveLength(0);
  });
});

// ── validatePhase1: duplicate detection ─────────────────

describe("validatePhase1 duplicate detection", () => {
  it("fails when two changes target the same name and type", () => {
    const result = validatePhase1({
      changes: [
        {
          target: "entity",
          operation: "create",
          name: "order",
          definition: {
            name: "order",
            fields: { title: { type: "string", label: "Title" } },
          },
        },
        {
          target: "entity",
          operation: "update",
          name: "order",
          definition: {
            name: "order",
            fields: {
              title: { type: "string", label: "Title" },
              amount: { type: "number", label: "Amount" },
            },
          },
        },
      ],
    });

    expect(result.status).toBe("failed");
    expect(result.errors.some((e) => e.code === "DUPLICATE_CHANGE")).toBe(true);
    expect(result.errors.find((e) => e.code === "DUPLICATE_CHANGE")?.message).toContain(
      "entity 'order' appears multiple times",
    );
  });

  it("allows same name on different targets", () => {
    const result = validatePhase1({
      changes: [
        {
          target: "entity",
          operation: "create",
          name: "order",
          definition: {
            name: "order",
            fields: { title: { type: "string", label: "Title" } },
          },
        },
        {
          target: "action",
          operation: "create",
          name: "order",
          definition: {
            name: "order",
            entity: "order",
            label: "Order",
            policy: { mode: "sync", transaction: true },
          },
        },
      ],
    });

    expect(result.errors.filter((e) => e.code === "DUPLICATE_CHANGE")).toHaveLength(0);
  });
});

// ── validatePhase1: dead-end state detection ────────────

describe("validatePhase1 dead-end state detection", () => {
  it("warns about dead-end states (incoming but no outgoing transitions)", () => {
    const result = validatePhase1({
      changes: [
        {
          target: "entity",
          operation: "create",
          name: "ticket",
          definition: {
            name: "ticket",
            fields: { title: { type: "string", label: "Title" } },
          },
        },
        {
          target: "state",
          operation: "create",
          name: "ticket_lifecycle",
          definition: {
            name: "ticket_lifecycle",
            entity: "ticket",
            field: "status",
            initial: "open",
            states: ["open", "in_progress", "closed"],
            transitions: [
              { from: "open", to: "in_progress", action: "start" },
              { from: "in_progress", to: "closed", action: "close" },
              // "closed" is a dead-end: has incoming but no outgoing
            ],
          },
        },
      ],
    });

    expect(result.warnings.some((w) => w.code === "STATE_DEAD_END")).toBe(true);
    expect(result.warnings.find((w) => w.code === "STATE_DEAD_END")?.message).toContain('"closed"');
  });

  it("does not warn about dead-end for initial state with no outgoing", () => {
    // If initial state has no transitions at all, there are no transitions period,
    // so the dead-end check is inside the transitions block and won't trigger.
    const result = validatePhase1({
      changes: [
        {
          target: "entity",
          operation: "create",
          name: "simple",
          definition: {
            name: "simple",
            fields: { title: { type: "string", label: "Title" } },
          },
        },
        {
          target: "state",
          operation: "create",
          name: "simple_state",
          definition: {
            name: "simple_state",
            entity: "simple",
            field: "status",
            initial: "active",
            states: ["active"],
            transitions: [],
          },
        },
      ],
    });

    expect(result.warnings.filter((w) => w.code === "STATE_DEAD_END")).toHaveLength(0);
  });
});
