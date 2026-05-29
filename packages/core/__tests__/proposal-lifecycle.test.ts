import { describe, expect, it } from "bun:test";
import { baseProposalOptions, createTestEngine } from "./helpers/proposal-fixtures";

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
