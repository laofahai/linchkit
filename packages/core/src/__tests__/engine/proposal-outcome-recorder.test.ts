import { describe, expect, it } from "bun:test";
import {
  createProposalOutcomeRecorder,
  type ProposalOutcomePayload,
  ProposalOutcomeRecorder,
} from "../../engine/proposal-outcome-recorder";
import { InMemoryMemoryStore } from "../../life-system/in-memory-memory-store";
import type { ProposalDefinition } from "../../types/proposal";

// ── Helpers ───────────────────────────────────────────────

function makeProposal(overrides: Partial<ProposalDefinition> = {}): ProposalDefinition {
  const now = new Date("2026-01-01T00:00:00Z");
  return {
    id: "prop-abc-12345678",
    title: "Add priority field",
    description: "Adds a priority field to the task entity",
    author: { type: "human", id: "user-1", name: "Alice" },
    capability: "cap-task",
    changeType: "minor",
    changes: [],
    impact: {
      schemasAffected: ["task"],
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

// ── ProposalOutcomeRecorder ───────────────────────────────

describe("ProposalOutcomeRecorder", () => {
  describe("factory", () => {
    it("createProposalOutcomeRecorder returns a ProposalOutcomeRecorder", () => {
      const store = new InMemoryMemoryStore();
      const recorder = createProposalOutcomeRecorder({ store });
      expect(recorder).toBeInstanceOf(ProposalOutcomeRecorder);
    });
  });

  describe("record — signal type", () => {
    it.each([
      ["accepted", "proposal:outcome:accepted"],
      ["rejected", "proposal:outcome:rejected"],
      ["merged", "proposal:outcome:merged"],
      ["withdrawn", "proposal:outcome:withdrawn"],
    ] as const)('outcome "%s" writes signal type "%s"', async (outcome, expectedType) => {
      const store = new InMemoryMemoryStore();
      const recorder = new ProposalOutcomeRecorder({ store });

      await recorder.record({ proposal: makeProposal(), outcome });

      const signals = await store.getSignals();
      expect(signals).toHaveLength(1);
      // biome-ignore lint/style/noNonNullAssertion: length verified above
      expect(signals[0]!.type).toBe(expectedType);
    });
  });

  describe("record — signal source", () => {
    it('writes source "event_bus"', async () => {
      const store = new InMemoryMemoryStore();
      const recorder = new ProposalOutcomeRecorder({ store });

      await recorder.record({ proposal: makeProposal(), outcome: "accepted" });

      const signals = await store.getSignals();
      // biome-ignore lint/style/noNonNullAssertion: length verified above
      expect(signals[0]!.source).toBe("event_bus");
    });
  });

  describe("record — timestamp", () => {
    it("writes a recent timestamp", async () => {
      const store = new InMemoryMemoryStore();
      const recorder = new ProposalOutcomeRecorder({ store });
      const before = new Date();

      await recorder.record({ proposal: makeProposal(), outcome: "accepted" });

      const after = new Date();
      const signals = await store.getSignals();
      // biome-ignore lint/style/noNonNullAssertion: length verified above
      const ts = signals[0]!.timestamp;
      expect(ts.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(ts.getTime()).toBeLessThanOrEqual(after.getTime());
    });
  });

  describe("record — payload", () => {
    it("includes core proposal fields in payload", async () => {
      const store = new InMemoryMemoryStore();
      const recorder = new ProposalOutcomeRecorder({ store });
      const proposal = makeProposal();

      await recorder.record({ proposal, outcome: "accepted" });

      const signals = await store.getSignals();
      // biome-ignore lint/style/noNonNullAssertion: length verified above
      const payload = signals[0]!.payload as ProposalOutcomePayload;
      expect(payload.proposalId).toBe(proposal.id);
      expect(payload.capability).toBe(proposal.capability);
      expect(payload.changeType).toBe(proposal.changeType);
      expect(payload.outcome).toBe("accepted");
      expect(typeof payload.recordedAt).toBe("string");
    });

    it("includes actorId when provided", async () => {
      const store = new InMemoryMemoryStore();
      const recorder = new ProposalOutcomeRecorder({ store });

      await recorder.record({
        proposal: makeProposal(),
        outcome: "accepted",
        actorId: "user-reviewer-1",
      });

      const signals = await store.getSignals();
      // biome-ignore lint/style/noNonNullAssertion: length verified above
      const payload = signals[0]!.payload as ProposalOutcomePayload;
      expect(payload.actorId).toBe("user-reviewer-1");
    });

    it("includes reason when provided", async () => {
      const store = new InMemoryMemoryStore();
      const recorder = new ProposalOutcomeRecorder({ store });

      await recorder.record({
        proposal: makeProposal(),
        outcome: "rejected",
        reason: "Not aligned with roadmap",
      });

      const signals = await store.getSignals();
      // biome-ignore lint/style/noNonNullAssertion: length verified above
      const payload = signals[0]!.payload as ProposalOutcomePayload;
      expect(payload.reason).toBe("Not aligned with roadmap");
    });

    it("omits reason when not provided", async () => {
      const store = new InMemoryMemoryStore();
      const recorder = new ProposalOutcomeRecorder({ store });

      await recorder.record({ proposal: makeProposal(), outcome: "accepted" });

      const signals = await store.getSignals();
      // biome-ignore lint/style/noNonNullAssertion: length verified above
      const payload = signals[0]!.payload as ProposalOutcomePayload;
      expect(payload.reason).toBeUndefined();
    });

    it("includes successMetric when present on proposal", async () => {
      const store = new InMemoryMemoryStore();
      const recorder = new ProposalOutcomeRecorder({ store });
      const proposal = makeProposal({
        successMetric: {
          baselineValue: 78,
          targetValue: 20,
          description: "Manual edit rate drops below 20%",
        },
      });

      await recorder.record({ proposal, outcome: "merged" });

      const signals = await store.getSignals();
      // biome-ignore lint/style/noNonNullAssertion: length verified above
      const payload = signals[0]!.payload as ProposalOutcomePayload;
      expect(payload.successMetric).toBeDefined();
      expect(payload.successMetric?.baselineValue).toBe(78);
      expect(payload.successMetric?.targetValue).toBe(20);
      expect(payload.successMetric?.description).toBe("Manual edit rate drops below 20%");
    });

    it("stored successMetric is a snapshot — mutating source does not affect stored signal", async () => {
      const store = new InMemoryMemoryStore();
      const recorder = new ProposalOutcomeRecorder({ store });
      const proposal = makeProposal({
        successMetric: {
          baselineValue: 78,
          targetValue: 20,
          description: "Edit rate drops below 20%",
        },
      });

      await recorder.record({ proposal, outcome: "merged" });

      // Mutate the source object after recording
      // biome-ignore lint/style/noNonNullAssertion: test setup guarantees it exists
      proposal.successMetric!.baselineValue = 999;
      // biome-ignore lint/style/noNonNullAssertion: test setup guarantees it exists
      proposal.successMetric!.description = "MUTATED";

      const signals = await store.getSignals();
      // biome-ignore lint/style/noNonNullAssertion: length verified above
      const payload = signals[0]!.payload as ProposalOutcomePayload;
      expect(payload.successMetric?.baselineValue).toBe(78);
      expect(payload.successMetric?.description).toBe("Edit rate drops below 20%");
    });

    it("omits successMetric when not present on proposal", async () => {
      const store = new InMemoryMemoryStore();
      const recorder = new ProposalOutcomeRecorder({ store });

      await recorder.record({ proposal: makeProposal(), outcome: "accepted" });

      const signals = await store.getSignals();
      // biome-ignore lint/style/noNonNullAssertion: length verified above
      const payload = signals[0]!.payload as ProposalOutcomePayload;
      expect(payload.successMetric).toBeUndefined();
    });
  });

  describe("record — multiple outcomes", () => {
    it("records each outcome as a separate signal", async () => {
      const store = new InMemoryMemoryStore();
      const recorder = new ProposalOutcomeRecorder({ store });

      const p1 = makeProposal({ id: "prop-1" });
      const p2 = makeProposal({ id: "prop-2", title: "Another proposal" });

      await recorder.record({ proposal: p1, outcome: "accepted" });
      await recorder.record({ proposal: p2, outcome: "rejected", reason: "Out of scope" });

      const signals = await store.getSignals();
      expect(signals).toHaveLength(2);
      // biome-ignore lint/style/noNonNullAssertion: length verified above
      expect((signals[0]!.payload as ProposalOutcomePayload).proposalId).toBe("prop-1");
      // biome-ignore lint/style/noNonNullAssertion: length verified above
      expect((signals[1]!.payload as ProposalOutcomePayload).proposalId).toBe("prop-2");
    });
  });
});

// ── ProposalSuccessMetric ──────────────────────────────────

describe("ProposalDefinition.successMetric", () => {
  it("accepts a full successMetric definition", () => {
    const proposal = makeProposal({
      successMetric: {
        description: "Edit rate drops below 20%",
        signalRef: "insight-42",
        baselineValue: 78,
        targetValue: 20,
      },
    });
    expect(proposal.successMetric?.description).toBe("Edit rate drops below 20%");
    expect(proposal.successMetric?.baselineValue).toBe(78);
    expect(proposal.successMetric?.targetValue).toBe(20);
  });

  it("accepts a minimal successMetric with required fields only", () => {
    const proposal = makeProposal({
      successMetric: { baselineValue: 0, targetValue: 100 },
    });
    expect(proposal.successMetric?.baselineValue).toBe(0);
    expect(proposal.successMetric?.description).toBeUndefined();
  });

  it("is undefined when not provided", () => {
    const proposal = makeProposal();
    expect(proposal.successMetric).toBeUndefined();
  });
});
