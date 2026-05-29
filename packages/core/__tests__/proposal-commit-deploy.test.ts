import { describe, expect, it } from "bun:test";
import { baseProposalOptions, createTestEngine } from "./helpers/proposal-fixtures";

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

describe("ProposalEngine: duplicate version detection", () => {
  it("auto-detects latest version when previousVersion is not provided", async () => {
    const engine = createTestEngine();

    // First proposal: commits as 0.1.0
    const p1 = engine.createProposal(baseProposalOptions);
    engine.submitProposal({ proposalId: p1.id });
    await engine.approveProposal({ proposalId: p1.id, approvedBy: { type: "human", id: "a" } });
    const { version: v1 } = engine.commitProposal({ proposalId: p1.id });
    expect(v1.version).toBe("0.1.0");

    // Second proposal: should auto-detect 0.1.0 and bump to 0.2.0
    const p2 = engine.createProposal({ ...baseProposalOptions, title: "Second" });
    engine.submitProposal({ proposalId: p2.id });
    await engine.approveProposal({ proposalId: p2.id, approvedBy: { type: "human", id: "a" } });
    const { version: v2 } = engine.commitProposal({ proposalId: p2.id });
    expect(v2.version).toBe("0.2.0");
    expect(v2.previousVersion).toBe("0.1.0");
  });

  it("throws when committing would create a duplicate version", async () => {
    const engine = createTestEngine();

    // First proposal: commits as 1.1.0
    const p1 = engine.createProposal(baseProposalOptions);
    engine.submitProposal({ proposalId: p1.id });
    await engine.approveProposal({ proposalId: p1.id, approvedBy: { type: "human", id: "a" } });
    engine.commitProposal({ proposalId: p1.id, previousVersion: "1.0.0" });

    // Second proposal with explicit previousVersion that would create the same version
    const p2 = engine.createProposal({ ...baseProposalOptions, title: "Duplicate" });
    engine.submitProposal({ proposalId: p2.id });
    await engine.approveProposal({ proposalId: p2.id, approvedBy: { type: "human", id: "a" } });

    expect(() => engine.commitProposal({ proposalId: p2.id, previousVersion: "1.0.0" })).toThrow(
      'Version "1.1.0" already exists',
    );
  });
});
