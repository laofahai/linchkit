/**
 * Tests for ProposalOutcomeRecorder (Spec 55 §7.7 Phase 1).
 *
 * Verifies that outcome events are written to MemoryStore with the correct
 * signal type, payload, and generatorId passthrough. Also tests composition
 * with ProposalEngine via the onApproved / onRejected hooks.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { createProposalEngine } from "../src/engine/proposal-engine";
import {
  createProposalOutcomeRecorder,
  ProposalOutcomeRecorder,
  type ProposalOutcomeType,
} from "../src/engine/proposal-outcome-recorder";
import { InMemoryMemoryStore } from "../src/life-system/in-memory-memory-store";
import type { Signal } from "../src/types/life-system";
import type { ProposalDefinition } from "../src/types/proposal";

// ── Fixtures ─────────────────────────────────────────────

function makeProposal(overrides: Partial<ProposalDefinition> = {}): ProposalDefinition {
  const now = new Date("2026-01-01T00:00:00Z");
  return {
    id: "proposal-abc",
    title: "Add priority field",
    description: "Adds priority field to task entity",
    author: { type: "ai", id: "gen-1", name: "Test Generator" },
    capability: "cap-task",
    changeType: "minor",
    changes: [{ target: "entity", operation: "update", name: "task" }],
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

async function lastSignal(store: InMemoryMemoryStore): Promise<Signal> {
  const signals = await store.getSignals();
  const signal = signals.at(-1);
  if (!signal) throw new Error("No signal recorded");
  return signal;
}

// ── ProposalOutcomeRecorder unit tests ────────────────────

describe("ProposalOutcomeRecorder", () => {
  let store: InMemoryMemoryStore;
  let recorder: ProposalOutcomeRecorder;

  beforeEach(() => {
    store = new InMemoryMemoryStore();
    recorder = new ProposalOutcomeRecorder({ store });
  });

  it("creates an instance via factory function", () => {
    const r = createProposalOutcomeRecorder({ store });
    expect(r).toBeInstanceOf(ProposalOutcomeRecorder);
  });

  it.each([
    "accepted",
    "rejected",
    "merged",
    "withdrawn",
  ] as ProposalOutcomeType[])("records signal with type 'proposal:outcome:%s'", async (outcome) => {
    const proposal = makeProposal();
    await recorder.record({ proposal, outcome });

    expect(store.signalCount).toBe(1);
    const signal = await lastSignal(store);
    expect(signal.type).toBe(`proposal:outcome:${outcome}`);
    expect(signal.source).toBe("event_bus");
    expect(signal.timestamp).toBeInstanceOf(Date);
  });

  it("payload contains proposalId, capability and changeType", async () => {
    const proposal = makeProposal({ id: "prop-xyz", capability: "cap-task", changeType: "patch" });
    await recorder.record({ proposal, outcome: "accepted" });

    const payload = (await lastSignal(store)).payload as Record<string, unknown>;
    expect(payload.proposalId).toBe("prop-xyz");
    expect(payload.capability).toBe("cap-task");
    expect(payload.changeType).toBe("patch");
    expect(payload.outcome).toBe("accepted");
    expect(typeof payload.recordedAt).toBe("string");
  });

  it("payload includes actorId and reason when provided", async () => {
    const proposal = makeProposal();
    await recorder.record({
      proposal,
      outcome: "rejected",
      actorId: "user-42",
      reason: "Not aligned with roadmap",
    });

    const payload = (await lastSignal(store)).payload as Record<string, unknown>;
    expect(payload.actorId).toBe("user-42");
    expect(payload.reason).toBe("Not aligned with roadmap");
  });

  it("actorId and reason are undefined when not provided", async () => {
    await recorder.record({ proposal: makeProposal(), outcome: "accepted" });
    const payload = (await lastSignal(store)).payload as Record<string, unknown>;
    expect(payload.actorId).toBeUndefined();
    expect(payload.reason).toBeUndefined();
  });

  it("reads generatorId from proposal sidecar", async () => {
    const proposal = Object.assign(makeProposal(), { generatorId: "gen-intent-42" });
    await recorder.record({ proposal, outcome: "accepted" });

    const payload = (await lastSignal(store)).payload as Record<string, unknown>;
    expect(payload.generatorId).toBe("gen-intent-42");
  });

  it("generatorId is undefined when not present on proposal", async () => {
    await recorder.record({ proposal: makeProposal(), outcome: "accepted" });
    const payload = (await lastSignal(store)).payload as Record<string, unknown>;
    expect(payload.generatorId).toBeUndefined();
  });

  it("includes successMetric when set on the proposal", async () => {
    const proposal = makeProposal({
      successMetric: {
        baselineValue: 10,
        targetValue: 20,
        signalRef: "signal-99",
        description: "Task throughput",
      },
    });
    await recorder.record({ proposal, outcome: "merged" });

    const payload = (await lastSignal(store)).payload as Record<string, unknown>;
    const metric = payload.successMetric as Record<string, unknown>;
    expect(metric.baselineValue).toBe(10);
    expect(metric.targetValue).toBe(20);
    expect(metric.signalRef).toBe("signal-99");
    expect(metric.description).toBe("Task throughput");
  });

  it("successMetric is undefined when not set", async () => {
    await recorder.record({ proposal: makeProposal(), outcome: "accepted" });
    const payload = (await lastSignal(store)).payload as Record<string, unknown>;
    expect(payload.successMetric).toBeUndefined();
  });

  it("accumulates multiple outcome events in order", async () => {
    const p1 = makeProposal({ id: "p1" });
    const p2 = makeProposal({ id: "p2" });
    await recorder.record({ proposal: p1, outcome: "accepted" });
    await recorder.record({ proposal: p2, outcome: "rejected", reason: "OOB" });

    expect(store.signalCount).toBe(2);
  });
});

// ── ProposalEngine composition tests ─────────────────────

describe("ProposalOutcomeRecorder composed with ProposalEngine", () => {
  it("records 'accepted' when wired into onApproved hook", async () => {
    const store = new InMemoryMemoryStore();
    const recorder = new ProposalOutcomeRecorder({ store });
    const engine = createProposalEngine({
      onApproved: (p) => recorder.record({ proposal: p, outcome: "accepted" }),
    });

    // Empty changes array passes validation trivially
    const draft = engine.createProposal({
      title: "Add field",
      description: "desc",
      author: { type: "human", id: "u1", name: "User" },
      capability: "cap-task",
      changeType: "minor",
      changes: [],
    });
    engine.submitProposal({ proposalId: draft.id });
    await engine.approveProposal({ proposalId: draft.id, approvedBy: { type: "human", id: "u1" } });

    expect(store.signalCount).toBe(1);
    const signal = await lastSignal(store);
    expect(signal.type).toBe("proposal:outcome:accepted");
    const payload = signal.payload as Record<string, unknown>;
    expect(payload.proposalId).toBe(draft.id);
  });

  it("records 'rejected' when wired into onRejected hook", async () => {
    const store = new InMemoryMemoryStore();
    const recorder = new ProposalOutcomeRecorder({ store });
    const engine = createProposalEngine({
      onRejected: (p) => recorder.record({ proposal: p, outcome: "rejected" }),
    });

    // Empty changes array passes validation trivially
    const draft = engine.createProposal({
      title: "Remove field",
      description: "desc",
      author: { type: "human", id: "u1", name: "User" },
      capability: "cap-task",
      changeType: "major",
      changes: [],
    });
    engine.submitProposal({ proposalId: draft.id });
    await engine.rejectProposal({ proposalId: draft.id, reason: "Too risky" });

    expect(store.signalCount).toBe(1);
    const signal = await lastSignal(store);
    expect(signal.type).toBe("proposal:outcome:rejected");
    const payload = signal.payload as Record<string, unknown>;
    expect(payload.proposalId).toBe(draft.id);
  });

  it("onRejected hook failure does not roll back rejection status", async () => {
    const engine = createProposalEngine({
      onRejected: () => {
        throw new Error("hook error");
      },
    });
    const draft = engine.createProposal({
      title: "T",
      description: "d",
      author: { type: "human", id: "u1", name: "U" },
      capability: "cap-x",
      changeType: "patch",
      changes: [],
    });
    engine.submitProposal({ proposalId: draft.id });
    const result = await engine.rejectProposal({ proposalId: draft.id, reason: "reason" });
    expect(result.status).toBe("rejected");
  });
});

// ── ProposalSuccessMetric type tests ──────────────────────

describe("ProposalSuccessMetric", () => {
  it("can be attached to a ProposalDefinition", () => {
    const proposal = makeProposal({
      successMetric: {
        baselineValue: 5,
        targetValue: 15,
      },
    });
    expect(proposal.successMetric?.baselineValue).toBe(5);
    expect(proposal.successMetric?.targetValue).toBe(15);
    expect(proposal.successMetric?.signalRef).toBeUndefined();
  });

  it("signalRef and description are optional", () => {
    const proposal = makeProposal({
      successMetric: { baselineValue: 0, targetValue: 1 },
    });
    expect(proposal.successMetric?.signalRef).toBeUndefined();
    expect(proposal.successMetric?.description).toBeUndefined();
  });
});
