import { describe, expect, it } from "bun:test";
import { baseProposalOptions, createTestEngine } from "./helpers/proposal-fixtures";

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
        target: "entity" as const,
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
          entity: "order",
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
          target: "entity",
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
          target: "entity",
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

describe("ProposalEngine.listVersions", () => {
  it("returns version records for a capability", async () => {
    const engine = createTestEngine();

    // Commit two proposals
    const p1 = engine.createProposal(baseProposalOptions);
    engine.submitProposal({ proposalId: p1.id });
    await engine.approveProposal({ proposalId: p1.id, approvedBy: { type: "human", id: "a" } });
    engine.commitProposal({ proposalId: p1.id, previousVersion: "0.0.0" });

    const p2 = engine.createProposal({
      ...baseProposalOptions,
      title: "Add category field",
      changeType: "patch",
    });
    engine.submitProposal({ proposalId: p2.id });
    await engine.approveProposal({ proposalId: p2.id, approvedBy: { type: "human", id: "a" } });
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
