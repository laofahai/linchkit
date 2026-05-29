import { describe, expect, it } from "bun:test";
import { baseProposalOptions, createTestEngine } from "./proposal-fixtures";

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

// ── ProposalEngine: approveProposal ─────────────────────

describe("ProposalEngine.approveProposal", () => {
  it("moves a validated proposal to 'approved'", async () => {
    const engine = createTestEngine();
    const proposal = engine.createProposal(baseProposalOptions);
    engine.submitProposal({ proposalId: proposal.id });

    const result = await engine.approveProposal({
      proposalId: proposal.id,
      approvedBy: { type: "human", id: "admin-1" },
    });

    expect(result.status).toBe("approved");
    expect(result.approvedBy).toEqual({ type: "human", id: "admin-1" });
    expect(result.approvedAt).toBeInstanceOf(Date);
  });

  it("throws when approving a non-validated proposal", async () => {
    const engine = createTestEngine();
    const proposal = engine.createProposal(baseProposalOptions);

    await expect(
      engine.approveProposal({
        proposalId: proposal.id,
        approvedBy: { type: "human", id: "admin-1" },
      }),
    ).rejects.toThrow('expected status "validated"');
  });
});

// ── ProposalEngine: rejectProposal ──────────────────────

describe("ProposalEngine.rejectProposal", () => {
  it("moves a validated proposal to 'rejected'", async () => {
    const engine = createTestEngine();
    const proposal = engine.createProposal(baseProposalOptions);
    engine.submitProposal({ proposalId: proposal.id });

    const result = engine.rejectProposal({
      proposalId: proposal.id,
      reason: "Not needed right now",
    });

    // rejectProposal returns void; re-read to verify state transition
    await expect(result).resolves.toBeUndefined();
    const rejected = engine.getProposal(proposal.id);
    expect(rejected.status).toBe("rejected");
    expect(rejected.rejectionReason).toBe("Not needed right now");
  });

  it("throws when rejecting a non-validated proposal", async () => {
    const engine = createTestEngine();
    const proposal = engine.createProposal(baseProposalOptions);

    await expect(
      engine.rejectProposal({ proposalId: proposal.id, reason: "no" }),
    ).rejects.toThrow('expected status "validated"');
  });
});

// ── ProposalEngine: commitProposal ──────────────────────

describe("ProposalEngine.commitProposal", () => {
  it("commits an approved proposal and creates a version record", async () => {
    const engine = createTestEngine();
    const proposal = engine.createProposal(baseProposalOptions);
    engine.submitProposal({ proposalId: proposal.id });
    await engine.approveProposal({
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

  it("bumps version correctly based on changeType", async () => {
    // patch
    const engine1 = createTestEngine();
    const p1 = engine1.createProposal({ ...baseProposalOptions, changeType: "patch" });
    engine1.submitProposal({ proposalId: p1.id });
    await engine1.approveProposal({ proposalId: p1.id, approvedBy: { type: "human", id: "a" } });
    const { version: v1 } = engine1.commitProposal({
      proposalId: p1.id,
      previousVersion: "2.3.5",
    });
    expect(v1.version).toBe("2.3.6");

    // major
    const engine2 = createTestEngine();
    const p2 = engine2.createProposal({ ...baseProposalOptions, changeType: "major" });
    engine2.submitProposal({ proposalId: p2.id });
    await engine2.approveProposal({ proposalId: p2.id, approvedBy: { type: "human", id: "a" } });
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

  it("defaults previousVersion to 0.0.0 when not provided", async () => {
    const engine = createTestEngine();
    const proposal = engine.createProposal(baseProposalOptions);
    engine.submitProposal({ proposalId: proposal.id });
    await engine.approveProposal({
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
  it("deploys a committed proposal", async () => {
    const engine = createTestEngine();
    const proposal = engine.createProposal(baseProposalOptions);
    engine.submitProposal({ proposalId: proposal.id });
    await engine.approveProposal({
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

// ── Full lifecycle: happy path ──────────────────────────

describe("Full proposal lifecycle", () => {
  it("draft → validated → approved → committed → deployed", async () => {
    const engine = createTestEngine();

    // Create
    const proposal = engine.createProposal(baseProposalOptions);
    expect(proposal.status).toBe("draft");

    // Submit (validate)
    engine.submitProposal({ proposalId: proposal.id });
    expect(engine.getProposal(proposal.id).status).toBe("validated");

    // Approve
    await engine.approveProposal({
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
