import { describe, expect, it } from "bun:test";
import { validatePhase1, validateProposal } from "../src/server-entry";
import { baseProposalOptions, createTestEngine } from "./helpers/proposal-fixtures";

describe("ProposalEngine.submitProposal", () => {
  it("validates and moves a valid proposal to 'validated'", () => {
    const engine = createTestEngine();
    const proposal = engine.createProposal(baseProposalOptions);
    const result = engine.submitProposal({ proposalId: proposal.id });

    expect(result.status).toBe("validated");
    expect(result.validationResult).toBeTruthy();
    expect(result.validationResult?.passed).toBe(true);
    expect(result.validatedAt).toBeInstanceOf(Date);
  });

  it("keeps proposal in 'draft' when validation fails and preserves errors", () => {
    const engine = createTestEngine();
    const proposal = engine.createProposal({
      ...baseProposalOptions,
      changes: [
        {
          target: "entity",
          operation: "create",
          name: "bad_schema",
          definition: {
            name: "bad_schema",
            fields: {}, // No fields — will fail
          },
        },
      ],
    });

    const result = engine.submitProposal({ proposalId: proposal.id });
    expect(result.status).toBe("draft");
    expect(result.validationResult?.passed).toBe(false);
    expect(result.lastValidationAt).toBeInstanceOf(Date);

    // Verify errors are visible via getProposal
    const fetched = engine.getProposal(proposal.id);
    expect(fetched.validationResult).toBeTruthy();
    expect(fetched.validationResult?.passed).toBe(false);
    expect(fetched.validationResult?.phases[0].errors.length).toBeGreaterThan(0);
    expect(fetched.lastValidationAt).toBeInstanceOf(Date);
  });

  it("throws when submitting a non-draft proposal", () => {
    const engine = createTestEngine();
    const proposal = engine.createProposal(baseProposalOptions);
    engine.submitProposal({ proposalId: proposal.id }); // now "validated"

    expect(() => engine.submitProposal({ proposalId: proposal.id })).toThrow(
      'expected status "draft"',
    );
  });
});

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
});

describe("validateProposal", () => {
  it("returns full validation result with all 4 phases", () => {
    const engine = createTestEngine();
    const proposal = engine.createProposal(baseProposalOptions);

    const result = validateProposal({ proposal });

    expect(result.phases).toHaveLength(4);
    expect(result.phases[0].phase).toBe(1);
    expect(result.phases[0].status).toBe("passed");
    expect(result.phases[1].phase).toBe(2);
    expect(result.phases[1].status).toBe("skipped");
    expect(result.phases[2].phase).toBe(3);
    expect(result.phases[2].status).toBe("skipped");
    expect(result.phases[3].phase).toBe(4);
    expect(result.phases[3].status).toBe("skipped");
    expect(result.impactSummary).toContain("1 change(s)");
  });
});
