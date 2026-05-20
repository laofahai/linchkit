import { describe, expect, it } from "bun:test";
import {
  createProposalOutcomeRecorder,
  type ProposalOutcomeRecord,
  ProposalOutcomeRecorder,
} from "../../engine/proposal-outcome-recorder";
import { InMemoryMemoryStore } from "../../life-system/in-memory-memory-store";
import type { ProposalDefinition, ProposalSuccessMetric } from "../../types/proposal";

// ── Helpers ───────────────────────────────────────────────

function makeProposal(overrides: Partial<ProposalDefinition> = {}): ProposalDefinition {
  const now = new Date();
  return {
    id: "test-proposal-001",
    title: "Test proposal",
    description: "For testing",
    author: { type: "human", id: "user-1", name: "Tester" },
    capability: "cap-test",
    changeType: "minor",
    changes: [],
    impact: {
      schemasAffected: [],
      actionsAffected: [],
      rulesAffected: [],
      dependentsAffected: [],
      migrationRequired: false,
    },
    status: "approved",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function readOutcomes(store: InMemoryMemoryStore): Promise<ProposalOutcomeRecord[]> {
  const signals = await store.getSignals();
  return signals.map((s) => s.payload as ProposalOutcomeRecord);
}

// ── ProposalOutcomeRecorder ───────────────────────────────

describe("ProposalOutcomeRecorder", () => {
  describe("record — accepted", () => {
    it("writes a signal with type 'proposal.outcome.accepted'", async () => {
      const store = new InMemoryMemoryStore();
      const recorder = new ProposalOutcomeRecorder({ store });
      const proposal = makeProposal({ status: "approved" });

      await recorder.record(proposal, "accepted");

      const signals = await store.getSignals();
      expect(signals).toHaveLength(1);
      // biome-ignore lint/style/noNonNullAssertion: length checked above
      expect(signals[0]!.type).toBe("proposal.outcome.accepted");
      // biome-ignore lint/style/noNonNullAssertion: length checked above
      expect(signals[0]!.source).toBe("event_bus");
    });

    it("payload carries proposalId, capability and changeType", async () => {
      const store = new InMemoryMemoryStore();
      const recorder = new ProposalOutcomeRecorder({ store });
      const proposal = makeProposal({
        id: "prop-abc",
        capability: "cap-orders",
        changeType: "major",
        status: "approved",
      });

      await recorder.record(proposal, "accepted");

      const [record] = await readOutcomes(store);
      expect(record?.proposalId).toBe("prop-abc");
      expect(record?.capability).toBe("cap-orders");
      expect(record?.changeType).toBe("major");
      expect(record?.outcome).toBe("accepted");
    });

    it("payload recordedAt is an ISO-8601 string", async () => {
      const store = new InMemoryMemoryStore();
      const recorder = new ProposalOutcomeRecorder({ store });

      await recorder.record(makeProposal(), "accepted");

      const [record] = await readOutcomes(store);
      expect(typeof record?.recordedAt).toBe("string");
      // biome-ignore lint/style/noNonNullAssertion: length verified two lines above
      expect(() => new Date(record!.recordedAt)).not.toThrow();
      // biome-ignore lint/style/noNonNullAssertion: length verified above
      expect(Number.isNaN(new Date(record!.recordedAt).getTime())).toBe(false);
    });
  });

  describe("record — rejected", () => {
    it("includes rejection reason when present", async () => {
      const store = new InMemoryMemoryStore();
      const recorder = new ProposalOutcomeRecorder({ store });
      const proposal = makeProposal({
        status: "rejected",
        rejectionReason: "Not aligned with roadmap",
      });

      await recorder.record(proposal, "rejected");

      const [record] = await readOutcomes(store);
      expect(record?.outcome).toBe("rejected");
      expect(record?.reason).toBe("Not aligned with roadmap");
    });

    it("omits reason field when rejectionReason is absent", async () => {
      const store = new InMemoryMemoryStore();
      const recorder = new ProposalOutcomeRecorder({ store });
      const proposal = makeProposal({ status: "rejected" });

      await recorder.record(proposal, "rejected");

      const [record] = await readOutcomes(store);
      expect(record?.reason).toBeUndefined();
    });
  });

  describe("record — merged and withdrawn", () => {
    it("records merged outcome without reason", async () => {
      const store = new InMemoryMemoryStore();
      const recorder = new ProposalOutcomeRecorder({ store });

      await recorder.record(makeProposal({ status: "committed" }), "merged");

      const [record] = await readOutcomes(store);
      expect(record?.outcome).toBe("merged");
      expect(record?.reason).toBeUndefined();
    });

    it("records withdrawn outcome", async () => {
      const store = new InMemoryMemoryStore();
      const recorder = new ProposalOutcomeRecorder({ store });

      await recorder.record(makeProposal({ status: "draft" }), "withdrawn");

      const [record] = await readOutcomes(store);
      expect(record?.outcome).toBe("withdrawn");
    });
  });

  describe("successMetric propagation", () => {
    it("copies successMetric into the outcome record when present", async () => {
      const store = new InMemoryMemoryStore();
      const recorder = new ProposalOutcomeRecorder({ store });
      const metric: ProposalSuccessMetric = {
        signalRef: "insight-supplier-contact-edit-rate",
        description: "Manual edit rate drops below 20%",
        baselineValue: 0.45,
        targetValue: 0.2,
      };
      const proposal = makeProposal({ successMetric: metric });

      await recorder.record(proposal, "accepted");

      const [record] = await readOutcomes(store);
      expect(record?.successMetric).toEqual(metric);
    });

    it("omits successMetric from the record when not set on the proposal", async () => {
      const store = new InMemoryMemoryStore();
      const recorder = new ProposalOutcomeRecorder({ store });

      await recorder.record(makeProposal(), "accepted");

      const [record] = await readOutcomes(store);
      expect(record?.successMetric).toBeUndefined();
    });
  });

  describe("multiple outcomes", () => {
    it("each record() call appends an independent signal", async () => {
      const store = new InMemoryMemoryStore();
      const recorder = new ProposalOutcomeRecorder({ store });
      const p1 = makeProposal({ id: "p1" });
      const p2 = makeProposal({ id: "p2", status: "rejected", rejectionReason: "too broad" });

      await recorder.record(p1, "accepted");
      await recorder.record(p2, "rejected");

      const signals = await store.getSignals();
      expect(signals).toHaveLength(2);
      const outcomes = await readOutcomes(store);
      expect(outcomes[0]?.proposalId).toBe("p1");
      expect(outcomes[1]?.proposalId).toBe("p2");
    });
  });

  describe("logger integration", () => {
    it("calls logger.info after a successful record", async () => {
      const store = new InMemoryMemoryStore();
      const logs: string[] = [];
      const recorder = new ProposalOutcomeRecorder({
        store,
        logger: { info: (msg) => logs.push(msg) },
      });

      await recorder.record(makeProposal(), "accepted");

      expect(logs.length).toBe(1);
      expect(logs[0]).toContain("accepted");
      expect(logs[0]).toContain("test-proposal-001");
    });

    it("works without a logger (no throw)", async () => {
      const store = new InMemoryMemoryStore();
      const recorder = new ProposalOutcomeRecorder({ store });
      await expect(recorder.record(makeProposal(), "merged")).resolves.toBeUndefined();
    });
  });

  describe("createProposalOutcomeRecorder factory", () => {
    it("returns a ProposalOutcomeRecorder instance", () => {
      const store = new InMemoryMemoryStore();
      const recorder = createProposalOutcomeRecorder({ store });
      expect(recorder).toBeInstanceOf(ProposalOutcomeRecorder);
    });
  });
});

// ── ProposalSuccessMetric (type shape) ────────────────────

describe("ProposalSuccessMetric", () => {
  it("successMetric field is optional on ProposalDefinition", () => {
    const proposal = makeProposal();
    expect(proposal.successMetric).toBeUndefined();
  });

  it("successMetric fields are accessible when set", () => {
    const metric: ProposalSuccessMetric = {
      signalRef: "signal-abc",
      baselineValue: 10,
      targetValue: 5,
    };
    const proposal = makeProposal({ successMetric: metric });
    expect(proposal.successMetric?.signalRef).toBe("signal-abc");
    expect(proposal.successMetric?.baselineValue).toBe(10);
    expect(proposal.successMetric?.targetValue).toBe(5);
    expect(proposal.successMetric?.description).toBeUndefined();
  });
});
