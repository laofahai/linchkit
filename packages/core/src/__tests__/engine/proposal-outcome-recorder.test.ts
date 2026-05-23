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

  describe("recordOutcome — signal type", () => {
    it.each([
      ["accepted", "proposal_outcome:accepted"],
      ["rejected", "proposal_outcome:rejected"],
      ["merged", "proposal_outcome:merged"],
      ["withdrawn", "proposal_outcome:withdrawn"],
    ] as const)('outcome "%s" writes signal type "%s"', async (outcome, expectedType) => {
      const store = new InMemoryMemoryStore();
      const recorder = new ProposalOutcomeRecorder({ store });

      await recorder.recordOutcome({ proposal: makeProposal(), outcome });

      const signals = await store.getSignals();
      expect(signals).toHaveLength(1);
      // biome-ignore lint/style/noNonNullAssertion: length verified above
      expect(signals[0]!.type).toBe(expectedType);
    });
  });

  describe("recordOutcome — signal source", () => {
    it('writes source "event_bus"', async () => {
      const store = new InMemoryMemoryStore();
      const recorder = new ProposalOutcomeRecorder({ store });

      await recorder.recordOutcome({ proposal: makeProposal(), outcome: "accepted" });

      const signals = await store.getSignals();
      // biome-ignore lint/style/noNonNullAssertion: length verified above
      expect(signals[0]!.source).toBe("event_bus");
    });
  });

  describe("recordOutcome — timestamp", () => {
    it("uses provided timestamp when given", async () => {
      const store = new InMemoryMemoryStore();
      const recorder = new ProposalOutcomeRecorder({ store });
      const ts = new Date("2026-06-01T12:00:00Z");

      await recorder.recordOutcome({ proposal: makeProposal(), outcome: "merged", timestamp: ts });

      const signals = await store.getSignals();
      // biome-ignore lint/style/noNonNullAssertion: length verified above
      expect(signals[0]!.timestamp).toEqual(ts);
    });

    it("defaults to current time when timestamp is omitted", async () => {
      const store = new InMemoryMemoryStore();
      const recorder = new ProposalOutcomeRecorder({ store });
      const before = new Date();

      await recorder.recordOutcome({ proposal: makeProposal(), outcome: "accepted" });

      const after = new Date();
      const signals = await store.getSignals();
      // biome-ignore lint/style/noNonNullAssertion: length verified above
      const ts = signals[0]!.timestamp;
      expect(ts.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(ts.getTime()).toBeLessThanOrEqual(after.getTime());
    });
  });

  describe("recordOutcome — payload", () => {
    it("includes core proposal fields in payload", async () => {
      const store = new InMemoryMemoryStore();
      const recorder = new ProposalOutcomeRecorder({ store });
      const proposal = makeProposal();

      await recorder.recordOutcome({ proposal, outcome: "accepted" });

      const signals = await store.getSignals();
      // biome-ignore lint/style/noNonNullAssertion: length verified above
      const payload = signals[0]!.payload as ProposalOutcomePayload;
      expect(payload.proposalId).toBe(proposal.id);
      expect(payload.proposalTitle).toBe(proposal.title);
      expect(payload.capability).toBe(proposal.capability);
      expect(payload.changeType).toBe(proposal.changeType);
      expect(payload.outcome).toBe("accepted");
      expect(payload.authorId).toBe(proposal.author.id);
      expect(payload.authorType).toBe(proposal.author.type);
    });

    it("includes reason when provided", async () => {
      const store = new InMemoryMemoryStore();
      const recorder = new ProposalOutcomeRecorder({ store });

      await recorder.recordOutcome({
        proposal: makeProposal(),
        outcome: "rejected",
        reason: "Not aligned with roadmap",
      });

      const signals = await store.getSignals();
      // biome-ignore lint/style/noNonNullAssertion: length verified above
      const payload = signals[0]!.payload as ProposalOutcomePayload;
      expect(payload.reason).toBe("Not aligned with roadmap");
    });

    it("omits reason field when not provided", async () => {
      const store = new InMemoryMemoryStore();
      const recorder = new ProposalOutcomeRecorder({ store });

      await recorder.recordOutcome({ proposal: makeProposal(), outcome: "accepted" });

      const signals = await store.getSignals();
      // biome-ignore lint/style/noNonNullAssertion: length verified above
      const payload = signals[0]!.payload as ProposalOutcomePayload;
      expect(Object.hasOwn(payload, "reason")).toBe(false);
    });

    it("includes successMetric when present on proposal", async () => {
      const store = new InMemoryMemoryStore();
      const recorder = new ProposalOutcomeRecorder({ store });
      const proposal = makeProposal({
        successMetric: {
          description: "Manual edit rate drops below 20%",
          baseline: 78,
          target: 20,
          unit: "%",
        },
      });

      await recorder.recordOutcome({ proposal, outcome: "merged" });

      const signals = await store.getSignals();
      // biome-ignore lint/style/noNonNullAssertion: length verified above
      const payload = signals[0]!.payload as ProposalOutcomePayload;
      expect(payload.successMetric).toEqual(proposal.successMetric);
    });

    it("stored successMetric is a snapshot — mutating source after record does not affect stored signal", async () => {
      const store = new InMemoryMemoryStore();
      const recorder = new ProposalOutcomeRecorder({ store });
      const proposal = makeProposal({
        successMetric: {
          description: "Edit rate drops below 20%",
          baseline: 78,
          target: 20,
          unit: "%",
        },
      });

      await recorder.recordOutcome({ proposal, outcome: "merged" });

      // Mutate the source object after recording
      // biome-ignore lint/style/noNonNullAssertion: test setup guarantees it exists
      proposal.successMetric!.description = "MUTATED";
      // biome-ignore lint/style/noNonNullAssertion: test setup guarantees it exists
      proposal.successMetric!.baseline = 999;

      const signals = await store.getSignals();
      // biome-ignore lint/style/noNonNullAssertion: length verified above
      const payload = signals[0]!.payload as ProposalOutcomePayload;
      expect(payload.successMetric?.description).toBe("Edit rate drops below 20%");
      expect(payload.successMetric?.baseline).toBe(78);
    });

    it("omits successMetric field when not present on proposal", async () => {
      const store = new InMemoryMemoryStore();
      const recorder = new ProposalOutcomeRecorder({ store });

      await recorder.recordOutcome({ proposal: makeProposal(), outcome: "accepted" });

      const signals = await store.getSignals();
      // biome-ignore lint/style/noNonNullAssertion: length verified above
      const payload = signals[0]!.payload as ProposalOutcomePayload;
      expect(Object.hasOwn(payload, "successMetric")).toBe(false);
    });
  });

  describe("recordOutcome — multiple outcomes", () => {
    it("records each outcome as a separate signal", async () => {
      const store = new InMemoryMemoryStore();
      const recorder = new ProposalOutcomeRecorder({ store });

      const p1 = makeProposal({ id: "prop-1" });
      const p2 = makeProposal({ id: "prop-2", title: "Another proposal" });

      await recorder.recordOutcome({ proposal: p1, outcome: "accepted" });
      await recorder.recordOutcome({ proposal: p2, outcome: "rejected", reason: "Out of scope" });

      const signals = await store.getSignals();
      expect(signals).toHaveLength(2);
      // biome-ignore lint/style/noNonNullAssertion: length verified above
      expect((signals[0]!.payload as ProposalOutcomePayload).proposalId).toBe("prop-1");
      // biome-ignore lint/style/noNonNullAssertion: length verified above
      expect((signals[1]!.payload as ProposalOutcomePayload).proposalId).toBe("prop-2");
    });
  });
});

// ── ProposalSuccessMetric ─────────────────────────────────

describe("ProposalDefinition.successMetric", () => {
  it("accepts a full successMetric definition", () => {
    const proposal = makeProposal({
      successMetric: {
        description: "Edit rate drops below 20%",
        signalRef: "insight-42",
        baseline: 78,
        target: 20,
        unit: "%",
      },
    });
    expect(proposal.successMetric?.description).toBe("Edit rate drops below 20%");
    expect(proposal.successMetric?.baseline).toBe(78);
    expect(proposal.successMetric?.target).toBe(20);
  });

  it("accepts a minimal successMetric with only description", () => {
    const proposal = makeProposal({
      successMetric: { description: "System runs faster" },
    });
    expect(proposal.successMetric?.description).toBe("System runs faster");
    expect(proposal.successMetric?.baseline).toBeUndefined();
  });

  it("is undefined when not provided", () => {
    const proposal = makeProposal();
    expect(proposal.successMetric).toBeUndefined();
  });
});
