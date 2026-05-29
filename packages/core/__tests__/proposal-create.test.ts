import { describe, expect, it } from "bun:test";
import { baseProposalOptions, createTestEngine } from "./helpers/proposal-fixtures";

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
