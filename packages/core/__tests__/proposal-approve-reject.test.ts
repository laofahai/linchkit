import { describe, expect, it } from "bun:test";
import { baseProposalOptions, createTestEngine } from "./helpers/proposal-fixtures";

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
