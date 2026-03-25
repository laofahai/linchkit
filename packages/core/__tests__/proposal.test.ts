import { describe, expect, it } from "bun:test";
import type { CreateProposalOptions, ProposalEngine } from "../src";
import {
  bumpVersion,
  createProposalEngine,
  validatePhase1,
  validateProposal,
} from "../src/server-entry";

// ── Test fixtures ───────────────────────────────────────

const baseProposalOptions: CreateProposalOptions = {
  title: "Add product schema",
  description: "Add a product schema with name, price, and category fields",
  author: { type: "human", id: "user-1", name: "Alice" },
  capability: "inventory_management",
  changeType: "minor",
  changes: [
    {
      target: "schema",
      operation: "create",
      name: "product",
      definition: {
        name: "product",
        label: "Product",
        fields: {
          name: { type: "string", required: true, default: "", label: "Name" },
          price: { type: "number", required: true, default: 0, label: "Price" },
          category: {
            type: "enum",
            label: "Category",
            options: [
              { value: "electronics", label: "Electronics" },
              { value: "clothing", label: "Clothing" },
            ],
          },
        },
      },
    },
  ],
};

function createTestEngine(): ProposalEngine {
  return createProposalEngine();
}

// ── ProposalEngine: createProposal ──────────────────────

describe("ProposalEngine.createProposal", () => {
  it("creates a proposal in draft status", () => {
    const engine = createTestEngine();
    const proposal = engine.createProposal(baseProposalOptions);

    expect(proposal.id).toBeTruthy();
    expect(proposal.status).toBe("draft");
    expect(proposal.title).toBe("Add product schema");
    expect(proposal.capability).toBe("inventory_management");
    expect(proposal.changeType).toBe("minor");
    expect(proposal.changes).toHaveLength(1);
    expect(proposal.createdAt).toBeInstanceOf(Date);
  });

  it("generates unique IDs for each proposal", () => {
    const engine = createTestEngine();
    const p1 = engine.createProposal(baseProposalOptions);
    const p2 = engine.createProposal(baseProposalOptions);
    expect(p1.id).not.toBe(p2.id);
  });

  it("auto-calculates impact from changes when not provided", () => {
    const engine = createTestEngine();
    const proposal = engine.createProposal(baseProposalOptions);

    expect(proposal.impact.schemasAffected).toEqual(["product"]);
    expect(proposal.impact.actionsAffected).toEqual([]);
    expect(proposal.impact.rulesAffected).toEqual([]);
    expect(proposal.impact.migrationRequired).toBe(false);
  });

  it("uses explicit impact when provided", () => {
    const engine = createTestEngine();
    const proposal = engine.createProposal({
      ...baseProposalOptions,
      impact: { schemasAffected: ["custom"], migrationRequired: true },
    });

    expect(proposal.impact.schemasAffected).toEqual(["custom"]);
    expect(proposal.impact.migrationRequired).toBe(true);
  });
});

// ── ProposalEngine: submitProposal (validation) ─────────

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
          target: "schema",
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

// ── ProposalEngine: approveProposal ─────────────────────

describe("ProposalEngine.approveProposal", () => {
  it("moves a validated proposal to 'approved'", () => {
    const engine = createTestEngine();
    const proposal = engine.createProposal(baseProposalOptions);
    engine.submitProposal({ proposalId: proposal.id });

    const result = engine.approveProposal({
      proposalId: proposal.id,
      approvedBy: { type: "human", id: "admin-1" },
    });

    expect(result.status).toBe("approved");
    expect(result.approvedBy).toEqual({ type: "human", id: "admin-1" });
    expect(result.approvedAt).toBeInstanceOf(Date);
  });

  it("throws when approving a non-validated proposal", () => {
    const engine = createTestEngine();
    const proposal = engine.createProposal(baseProposalOptions);

    expect(() =>
      engine.approveProposal({
        proposalId: proposal.id,
        approvedBy: { type: "human", id: "admin-1" },
      }),
    ).toThrow('expected status "validated"');
  });
});

// ── ProposalEngine: rejectProposal ──────────────────────

describe("ProposalEngine.rejectProposal", () => {
  it("moves a validated proposal to 'rejected'", () => {
    const engine = createTestEngine();
    const proposal = engine.createProposal(baseProposalOptions);
    engine.submitProposal({ proposalId: proposal.id });

    const result = engine.rejectProposal({
      proposalId: proposal.id,
      reason: "Not needed right now",
    });

    expect(result.status).toBe("rejected");
    expect(result.rejectionReason).toBe("Not needed right now");
  });

  it("throws when rejecting a non-validated proposal", () => {
    const engine = createTestEngine();
    const proposal = engine.createProposal(baseProposalOptions);

    expect(() => engine.rejectProposal({ proposalId: proposal.id, reason: "no" })).toThrow(
      'expected status "validated"',
    );
  });
});

// ── ProposalEngine: commitProposal ──────────────────────

describe("ProposalEngine.commitProposal", () => {
  it("commits an approved proposal and creates a version record", () => {
    const engine = createTestEngine();
    const proposal = engine.createProposal(baseProposalOptions);
    engine.submitProposal({ proposalId: proposal.id });
    engine.approveProposal({
      proposalId: proposal.id,
      approvedBy: { type: "human", id: "admin-1" },
    });

    const { proposal: committed, version } = engine.commitProposal({
      proposalId: proposal.id,
      previousVersion: "1.0.0",
      changelog: "Added product schema",
    });

    expect(committed.status).toBe("committed");
    expect(committed.committedAt).toBeInstanceOf(Date);

    expect(version).toBeTruthy();
    expect(version.capability).toBe("inventory_management");
    expect(version.version).toBe("1.1.0"); // minor bump from 1.0.0
    expect(version.previousVersion).toBe("1.0.0");
    expect(version.proposalId).toBe(proposal.id);
    expect(version.gitTag).toBe("inventory_management@1.1.0");
    expect(version.status).toBe("active");
  });

  it("bumps version correctly based on changeType", () => {
    // patch
    const engine1 = createTestEngine();
    const p1 = engine1.createProposal({ ...baseProposalOptions, changeType: "patch" });
    engine1.submitProposal({ proposalId: p1.id });
    engine1.approveProposal({ proposalId: p1.id, approvedBy: { type: "human", id: "a" } });
    const { version: v1 } = engine1.commitProposal({
      proposalId: p1.id,
      previousVersion: "2.3.5",
    });
    expect(v1.version).toBe("2.3.6");

    // major
    const engine2 = createTestEngine();
    const p2 = engine2.createProposal({ ...baseProposalOptions, changeType: "major" });
    engine2.submitProposal({ proposalId: p2.id });
    engine2.approveProposal({ proposalId: p2.id, approvedBy: { type: "human", id: "a" } });
    const { version: v2 } = engine2.commitProposal({
      proposalId: p2.id,
      previousVersion: "2.3.5",
    });
    expect(v2.version).toBe("3.0.0");
  });

  it("throws when committing a non-approved proposal", () => {
    const engine = createTestEngine();
    const proposal = engine.createProposal(baseProposalOptions);

    expect(() => engine.commitProposal({ proposalId: proposal.id })).toThrow(
      'expected status "approved"',
    );
  });

  it("defaults previousVersion to 0.0.0 when not provided", () => {
    const engine = createTestEngine();
    const proposal = engine.createProposal(baseProposalOptions);
    engine.submitProposal({ proposalId: proposal.id });
    engine.approveProposal({
      proposalId: proposal.id,
      approvedBy: { type: "human", id: "a" },
    });

    const { version } = engine.commitProposal({ proposalId: proposal.id });
    expect(version.previousVersion).toBe("0.0.0");
    expect(version.version).toBe("0.1.0"); // minor from 0.0.0
  });
});

// ── ProposalEngine: deployProposal ──────────────────────

describe("ProposalEngine.deployProposal", () => {
  it("deploys a committed proposal", () => {
    const engine = createTestEngine();
    const proposal = engine.createProposal(baseProposalOptions);
    engine.submitProposal({ proposalId: proposal.id });
    engine.approveProposal({
      proposalId: proposal.id,
      approvedBy: { type: "human", id: "admin-1" },
    });
    engine.commitProposal({ proposalId: proposal.id });

    const result = engine.deployProposal({ proposalId: proposal.id });
    expect(result.status).toBe("deployed");
    expect(result.deployedAt).toBeInstanceOf(Date);
  });

  it("throws when deploying a non-committed proposal", () => {
    const engine = createTestEngine();
    const proposal = engine.createProposal(baseProposalOptions);
    engine.submitProposal({ proposalId: proposal.id });

    expect(() => engine.deployProposal({ proposalId: proposal.id })).toThrow(
      'expected status "committed"',
    );
  });
});

// ── ProposalEngine: listProposals ───────────────────────

describe("ProposalEngine.listProposals", () => {
  it("lists all proposals", () => {
    const engine = createTestEngine();
    engine.createProposal(baseProposalOptions);
    engine.createProposal({ ...baseProposalOptions, title: "Second" });

    expect(engine.listProposals()).toHaveLength(2);
  });

  it("filters by status", () => {
    const engine = createTestEngine();
    engine.createProposal(baseProposalOptions);
    const p2 = engine.createProposal({ ...baseProposalOptions, title: "Second" });
    engine.submitProposal({ proposalId: p2.id });

    expect(engine.listProposals({ status: "draft" })).toHaveLength(1);
    expect(engine.listProposals({ status: "validated" })).toHaveLength(1);
  });

  it("filters by capability", () => {
    const engine = createTestEngine();
    engine.createProposal(baseProposalOptions);
    engine.createProposal({ ...baseProposalOptions, capability: "other_cap" });

    expect(engine.listProposals({ capability: "inventory_management" })).toHaveLength(1);
    expect(engine.listProposals({ capability: "other_cap" })).toHaveLength(1);
  });
});

// ── ProposalEngine: listVersions ────────────────────────

describe("ProposalEngine.listVersions", () => {
  it("returns version records for a capability", () => {
    const engine = createTestEngine();

    // Commit two proposals
    const p1 = engine.createProposal(baseProposalOptions);
    engine.submitProposal({ proposalId: p1.id });
    engine.approveProposal({ proposalId: p1.id, approvedBy: { type: "human", id: "a" } });
    engine.commitProposal({ proposalId: p1.id, previousVersion: "0.0.0" });

    const p2 = engine.createProposal({
      ...baseProposalOptions,
      title: "Add category field",
      changeType: "patch",
    });
    engine.submitProposal({ proposalId: p2.id });
    engine.approveProposal({ proposalId: p2.id, approvedBy: { type: "human", id: "a" } });
    engine.commitProposal({ proposalId: p2.id, previousVersion: "0.1.0" });

    const versions = engine.listVersions("inventory_management");
    expect(versions).toHaveLength(2);
    // Both versions should exist (order may vary for near-simultaneous commits)
    const versionStrings = versions.map((v) => v.version).sort();
    expect(versionStrings).toEqual(["0.1.0", "0.1.1"]);
  });

  it("returns empty array for unknown capability", () => {
    const engine = createTestEngine();
    expect(engine.listVersions("nonexistent")).toEqual([]);
  });
});

// ── validatePhase1 ──────────────────────────────────────

describe("validatePhase1", () => {
  it("passes for valid schema changes", () => {
    const result = validatePhase1({
      changes: [
        {
          target: "schema",
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
          target: "schema",
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
    expect(result.errors.some((e) => e.code === "SCHEMA_NO_FIELDS")).toBe(true);
  });

  it("fails for invalid field types", () => {
    const result = validatePhase1({
      changes: [
        {
          target: "schema",
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
          target: "schema",
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
          target: "schema",
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
          target: "schema",
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
            schema: "order",
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
            schema: "",
            label: "Bad",
            policy: { mode: "sync", transaction: false },
          },
        },
      ],
    });

    expect(result.status).toBe("failed");
    expect(result.errors.some((e) => e.code === "ACTION_NO_SCHEMA")).toBe(true);
  });

  it("validates state definition changes", () => {
    const result = validatePhase1({
      changes: [
        {
          target: "schema",
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
            schema: "order",
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
            schema: "order",
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
          target: "schema",
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
            schema: "order",
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
            schema: "order",
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
          target: "schema",
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
          target: "schema",
          operation: "create",
          name: "no_def",
        },
      ],
    });

    expect(result.status).toBe("failed");
    expect(result.errors.some((e) => e.code === "MISSING_DEFINITION")).toBe(true);
  });
});

// ── validateProposal ────────────────────────────────────

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

// ── bumpVersion ─────────────────────────────────────────

describe("bumpVersion", () => {
  it("bumps patch version", () => {
    expect(bumpVersion("1.2.3", "patch")).toBe("1.2.4");
  });

  it("bumps minor version and resets patch", () => {
    expect(bumpVersion("1.2.3", "minor")).toBe("1.3.0");
  });

  it("bumps major version and resets minor/patch", () => {
    expect(bumpVersion("1.2.3", "major")).toBe("2.0.0");
  });

  it("handles 0.0.0", () => {
    expect(bumpVersion("0.0.0", "patch")).toBe("0.0.1");
    expect(bumpVersion("0.0.0", "minor")).toBe("0.1.0");
    expect(bumpVersion("0.0.0", "major")).toBe("1.0.0");
  });

  it("throws for invalid semver", () => {
    expect(() => bumpVersion("not.a.version", "patch")).toThrow("Invalid semver");
    expect(() => bumpVersion("1.2", "patch")).toThrow("Invalid semver");
  });
});

// ── ProposalEngine: updateProposal ──────────────────────

describe("ProposalEngine.updateProposal", () => {
  it("updates title and description on a draft proposal", () => {
    const engine = createTestEngine();
    const proposal = engine.createProposal(baseProposalOptions);

    const updated = engine.updateProposal(proposal.id, {
      title: "Updated title",
      description: "Updated description",
    });

    expect(updated.title).toBe("Updated title");
    expect(updated.description).toBe("Updated description");
    expect(updated.changes).toHaveLength(1); // unchanged
  });

  it("updates changes and recalculates impact", () => {
    const engine = createTestEngine();
    const proposal = engine.createProposal(baseProposalOptions);

    const newChanges = [
      {
        target: "schema" as const,
        operation: "create" as const,
        name: "order",
        definition: {
          name: "order",
          fields: { title: { type: "string" as const, label: "Title" } },
        },
      },
      {
        target: "action" as const,
        operation: "create" as const,
        name: "create_order",
        definition: {
          name: "create_order",
          schema: "order",
          label: "Create Order",
          policy: { mode: "sync" as const, transaction: true },
        },
      },
    ];

    const updated = engine.updateProposal(proposal.id, { changes: newChanges });

    expect(updated.changes).toHaveLength(2);
    expect(updated.impact.schemasAffected).toEqual(["order"]);
    expect(updated.impact.actionsAffected).toEqual(["create_order"]);
  });

  it("throws when updating a non-draft proposal", () => {
    const engine = createTestEngine();
    const proposal = engine.createProposal(baseProposalOptions);
    engine.submitProposal({ proposalId: proposal.id }); // now "validated"

    expect(() => engine.updateProposal(proposal.id, { title: "new" })).toThrow(
      'expected status "draft"',
    );
  });

  it("allows update after failed validation, then re-submit succeeds", () => {
    const engine = createTestEngine();
    const proposal = engine.createProposal({
      ...baseProposalOptions,
      changes: [
        {
          target: "schema",
          operation: "create",
          name: "bad_schema",
          definition: { name: "bad_schema", fields: {} },
        },
      ],
    });

    // First submission fails validation
    engine.submitProposal({ proposalId: proposal.id });
    expect(engine.getProposal(proposal.id).status).toBe("draft");
    expect(engine.getProposal(proposal.id).validationResult?.passed).toBe(false);

    // Fix the changes
    engine.updateProposal(proposal.id, {
      changes: [
        {
          target: "schema",
          operation: "create",
          name: "good_schema",
          definition: {
            name: "good_schema",
            fields: { name: { type: "string", label: "Name" } },
          },
        },
      ],
    });

    // Re-submit succeeds
    const result = engine.submitProposal({ proposalId: proposal.id });
    expect(result.status).toBe("validated");
    expect(result.validationResult?.passed).toBe(true);
  });
});

// ── validatePhase1: duplicate detection ─────────────────

describe("validatePhase1 duplicate detection", () => {
  it("fails when two changes target the same name and type", () => {
    const result = validatePhase1({
      changes: [
        {
          target: "schema",
          operation: "create",
          name: "order",
          definition: {
            name: "order",
            fields: { title: { type: "string", label: "Title" } },
          },
        },
        {
          target: "schema",
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
      "schema 'order' appears multiple times",
    );
  });

  it("allows same name on different targets", () => {
    const result = validatePhase1({
      changes: [
        {
          target: "schema",
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
            schema: "order",
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
          target: "schema",
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
            schema: "ticket",
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
          target: "schema",
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
            schema: "simple",
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

// ── Full lifecycle: happy path ──────────────────────────

describe("Full proposal lifecycle", () => {
  it("draft → validated → approved → committed → deployed", () => {
    const engine = createTestEngine();

    // Create
    const proposal = engine.createProposal(baseProposalOptions);
    expect(proposal.status).toBe("draft");

    // Submit (validate)
    engine.submitProposal({ proposalId: proposal.id });
    expect(engine.getProposal(proposal.id).status).toBe("validated");

    // Approve
    engine.approveProposal({
      proposalId: proposal.id,
      approvedBy: { type: "human", id: "admin-1" },
    });
    expect(engine.getProposal(proposal.id).status).toBe("approved");

    // Commit
    const { version } = engine.commitProposal({
      proposalId: proposal.id,
      previousVersion: "1.0.0",
      changelog: "Added product schema",
    });
    expect(engine.getProposal(proposal.id).status).toBe("committed");
    expect(version.version).toBe("1.1.0");
    expect(version.status).toBe("active");

    // Deploy
    engine.deployProposal({ proposalId: proposal.id });
    expect(engine.getProposal(proposal.id).status).toBe("deployed");
  });

  it("draft → validated → rejected", () => {
    const engine = createTestEngine();

    const proposal = engine.createProposal(baseProposalOptions);
    engine.submitProposal({ proposalId: proposal.id });
    engine.rejectProposal({
      proposalId: proposal.id,
      reason: "Too many changes at once",
    });

    const rejected = engine.getProposal(proposal.id);
    expect(rejected.status).toBe("rejected");
    expect(rejected.rejectionReason).toBe("Too many changes at once");
  });
});

// ── P1: Duplicate version detection ─────────────────────

describe("ProposalEngine: duplicate version detection", () => {
  it("auto-detects latest version when previousVersion is not provided", () => {
    const engine = createTestEngine();

    // First proposal: commits as 0.1.0
    const p1 = engine.createProposal(baseProposalOptions);
    engine.submitProposal({ proposalId: p1.id });
    engine.approveProposal({ proposalId: p1.id, approvedBy: { type: "human", id: "a" } });
    const { version: v1 } = engine.commitProposal({ proposalId: p1.id });
    expect(v1.version).toBe("0.1.0");

    // Second proposal: should auto-detect 0.1.0 and bump to 0.2.0
    const p2 = engine.createProposal({ ...baseProposalOptions, title: "Second" });
    engine.submitProposal({ proposalId: p2.id });
    engine.approveProposal({ proposalId: p2.id, approvedBy: { type: "human", id: "a" } });
    const { version: v2 } = engine.commitProposal({ proposalId: p2.id });
    expect(v2.version).toBe("0.2.0");
    expect(v2.previousVersion).toBe("0.1.0");
  });

  it("throws when committing would create a duplicate version", () => {
    const engine = createTestEngine();

    // First proposal: commits as 1.1.0
    const p1 = engine.createProposal(baseProposalOptions);
    engine.submitProposal({ proposalId: p1.id });
    engine.approveProposal({ proposalId: p1.id, approvedBy: { type: "human", id: "a" } });
    engine.commitProposal({ proposalId: p1.id, previousVersion: "1.0.0" });

    // Second proposal with explicit previousVersion that would create the same version
    const p2 = engine.createProposal({ ...baseProposalOptions, title: "Duplicate" });
    engine.submitProposal({ proposalId: p2.id });
    engine.approveProposal({ proposalId: p2.id, approvedBy: { type: "human", id: "a" } });

    expect(() => engine.commitProposal({ proposalId: p2.id, previousVersion: "1.0.0" })).toThrow(
      'Version "1.1.0" already exists',
    );
  });
});

// ── P1: stateTransition validation against state machine ─

describe("validatePhase1: stateTransition against state machine", () => {
  it("fails when stateTransition.from references invalid state", () => {
    const result = validatePhase1({
      changes: [
        {
          target: "schema",
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
            schema: "order",
            field: "status",
            initial: "draft",
            states: ["draft", "confirmed", "done"],
            transitions: [
              { from: "draft", to: "confirmed", action: "confirm" },
              { from: "confirmed", to: "done", action: "complete" },
            ],
          },
        },
        {
          target: "action",
          operation: "create",
          name: "confirm_order",
          definition: {
            name: "confirm_order",
            schema: "order",
            label: "Confirm Order",
            policy: { mode: "sync", transaction: true },
            stateTransition: { from: "nonexistent", to: "confirmed" },
          },
        },
      ],
    });

    expect(result.status).toBe("failed");
    expect(result.errors.some((e) => e.code === "TRANSITION_INVALID_STATE")).toBe(true);
    expect(result.errors.find((e) => e.code === "TRANSITION_INVALID_STATE")?.message).toContain(
      "'nonexistent'",
    );
  });

  it("fails when stateTransition.to references invalid state", () => {
    const result = validatePhase1({
      changes: [
        {
          target: "schema",
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
            schema: "order",
            field: "status",
            initial: "draft",
            states: ["draft", "confirmed"],
            transitions: [{ from: "draft", to: "confirmed", action: "confirm" }],
          },
        },
        {
          target: "action",
          operation: "create",
          name: "ship_order",
          definition: {
            name: "ship_order",
            schema: "order",
            label: "Ship Order",
            policy: { mode: "sync", transaction: true },
            stateTransition: { from: "confirmed", to: "shipped" },
          },
        },
      ],
    });

    expect(result.status).toBe("failed");
    expect(result.errors.some((e) => e.code === "TRANSITION_INVALID_STATE")).toBe(true);
    expect(result.errors.find((e) => e.code === "TRANSITION_INVALID_STATE")?.message).toContain(
      "'shipped'",
    );
  });

  it("passes when stateTransition references valid states", () => {
    const result = validatePhase1({
      changes: [
        {
          target: "schema",
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
            schema: "order",
            field: "status",
            initial: "draft",
            states: ["draft", "confirmed"],
            transitions: [{ from: "draft", to: "confirmed", action: "confirm" }],
          },
        },
        {
          target: "action",
          operation: "create",
          name: "confirm_order",
          definition: {
            name: "confirm_order",
            schema: "order",
            label: "Confirm Order",
            policy: { mode: "sync", transaction: true },
            stateTransition: { from: "draft", to: "confirmed" },
          },
        },
      ],
    });

    expect(result.errors.filter((e) => e.code === "TRANSITION_INVALID_STATE")).toHaveLength(0);
  });
});

// ── P1: Phase 2 skipped doesn't block passed ────────────

describe("validateProposal: skipped phases don't block passed", () => {
  it("passes when Phase 1 passes and other phases are skipped", () => {
    const engine = createTestEngine();
    const proposal = engine.createProposal(baseProposalOptions);

    const result = validateProposal({ proposal });

    expect(result.passed).toBe(true);
    expect(result.phases[0].status).toBe("passed");
    expect(result.phases[1].status).toBe("skipped");
    expect(result.phases[2].status).toBe("skipped");
    expect(result.phases[3].status).toBe("skipped");
  });

  it("fails when Phase 1 fails even though other phases are skipped", () => {
    const engine = createTestEngine();
    const proposal = engine.createProposal({
      ...baseProposalOptions,
      changes: [
        {
          target: "schema",
          operation: "create",
          name: "empty",
          definition: { name: "empty", fields: {} },
        },
      ],
    });

    const result = validateProposal({ proposal });

    expect(result.passed).toBe(false);
    expect(result.phases[0].status).toBe("failed");
  });
});

// ── P2: Required without default is now an error ─────────

describe("validatePhase1: required field without default is error", () => {
  it("reports an error for required field without default", () => {
    const result = validatePhase1({
      changes: [
        {
          target: "schema",
          operation: "create",
          name: "product",
          definition: {
            name: "product",
            fields: {
              name: { type: "string", required: true, label: "Name" },
            },
          },
        },
      ],
    });

    expect(result.status).toBe("failed");
    expect(result.errors.some((e) => e.code === "REQUIRED_NO_DEFAULT")).toBe(true);
  });

  it("does not error for required field with a default value", () => {
    const result = validatePhase1({
      changes: [
        {
          target: "schema",
          operation: "create",
          name: "product",
          definition: {
            name: "product",
            fields: {
              name: { type: "string", required: true, default: "Untitled", label: "Name" },
            },
          },
        },
      ],
    });

    expect(result.errors.filter((e) => e.code === "REQUIRED_NO_DEFAULT")).toHaveLength(0);
  });

  it("does not error for computed required fields without default", () => {
    const result = validatePhase1({
      changes: [
        {
          target: "schema",
          operation: "create",
          name: "product",
          definition: {
            name: "product",
            fields: {
              total: { type: "computed", required: true, label: "Total" },
            },
          },
        },
      ],
    });

    expect(result.errors.filter((e) => e.code === "REQUIRED_NO_DEFAULT")).toHaveLength(0);
  });
});
