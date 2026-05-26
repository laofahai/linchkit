/**
 * Tests for ProposalEffectVerifier (Spec 55 §7.7 Phase 2).
 *
 * Verifies verdict computation, signal writes, rollback_candidate emission,
 * outcome filtering, default signalRef parsing, and clock injection.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import {
  createProposalEffectVerifier,
  type EffectVerdict,
  ProposalEffectVerifier,
} from "../src/engine/proposal-effect-verifier";
import type { ProposalOutcomePayload } from "../src/engine/proposal-outcome-recorder";
import { InMemoryMemoryStore } from "../src/life-system/in-memory-memory-store";
import type { Signal } from "../src/types/life-system";

// ── Fixtures ─────────────────────────────────────────────

function makeOutcome(overrides: Partial<ProposalOutcomePayload> = {}): ProposalOutcomePayload {
  return {
    proposalId: "proposal-abc",
    capability: "cap-task",
    changeType: "minor",
    outcome: "merged",
    recordedAt: "2026-01-01T00:00:00.000Z",
    successMetric: {
      signalRef: "task.completion_rate",
      baselineValue: 0.5,
      targetValue: 0.8,
    },
    ...overrides,
  };
}

async function lastSignal(store: InMemoryMemoryStore): Promise<Signal> {
  const sigs = await store.getSignals();
  const s = sigs.at(-1);
  if (!s) throw new Error("No signal recorded");
  return s;
}

async function signalsByType(store: InMemoryMemoryStore, type: string): Promise<Signal[]> {
  const sigs = await store.getSignals();
  return sigs.filter((s) => s.type === type);
}

// ── Constructor and factory ───────────────────────────────

describe("ProposalEffectVerifier", () => {
  let store: InMemoryMemoryStore;
  let verifier: ProposalEffectVerifier;

  beforeEach(() => {
    store = new InMemoryMemoryStore();
    verifier = new ProposalEffectVerifier({ store });
  });

  it("creates an instance via factory function", () => {
    const v = createProposalEffectVerifier({ store });
    expect(v).toBeInstanceOf(ProposalEffectVerifier);
  });

  // ── Filtering ─────────────────────────────────────────

  it("skips non-merged outcomes by default", async () => {
    const outcomes = [
      makeOutcome({ outcome: "accepted" }),
      makeOutcome({ outcome: "rejected" }),
      makeOutcome({ outcome: "withdrawn" }),
    ];
    const results = await verifier.verify({ outcomes });
    expect(results).toHaveLength(0);
    expect(store.signalCount).toBe(0);
  });

  it("skips merged outcomes without successMetric", async () => {
    const outcome = makeOutcome({ successMetric: undefined });
    const results = await verifier.verify({ outcomes: [outcome] });
    expect(results).toHaveLength(0);
    expect(store.signalCount).toBe(0);
  });

  it("returns empty results for empty input", async () => {
    const results = await verifier.verify({ outcomes: [] });
    expect(results).toHaveLength(0);
  });

  it("applies custom outcomeFilter", async () => {
    const outcomes = [makeOutcome({ outcome: "accepted" }), makeOutcome({ outcome: "merged" })];
    // filter to "accepted" only
    const results = await verifier.verify({ outcomes, outcomeFilter: "accepted" });
    expect(results).toHaveLength(1);
    expect(results[0].proposalId).toBe("proposal-abc");
  });

  // ── Verdict: effect_uncertain ─────────────────────────

  it("returns effect_uncertain when signalRef is absent", async () => {
    const outcome = makeOutcome({
      successMetric: { signalRef: undefined, baselineValue: 0.5, targetValue: 0.8 },
    });
    const [result] = await verifier.verify({ outcomes: [outcome] });
    expect(result.verdict).toBe("effect_uncertain");
    expect(result.currentValue).toBeNull();
  });

  it("returns effect_uncertain when getCurrentValue returns null", async () => {
    const v = createProposalEffectVerifier({
      store,
      getCurrentValue: async () => null,
    });
    const [result] = await v.verify({ outcomes: [makeOutcome()] });
    expect(result.verdict).toBe("effect_uncertain");
    expect(result.currentValue).toBeNull();
  });

  it("writes proposal:effect:uncertain signal on uncertainty", async () => {
    const v = createProposalEffectVerifier({
      store,
      getCurrentValue: async () => null,
    });
    await v.verify({ outcomes: [makeOutcome()] });
    const sigs = await signalsByType(store, "proposal:effect:uncertain");
    expect(sigs).toHaveLength(1);
    const payload = sigs[0].payload as { verdict: EffectVerdict };
    expect(payload.verdict).toBe("effect_uncertain");
  });

  // ── Verdict: effect_verified ──────────────────────────

  it("returns effect_verified when currentValue >= targetValue", async () => {
    const v = createProposalEffectVerifier({
      store,
      getCurrentValue: async () => 0.9,
    });
    const [result] = await v.verify({ outcomes: [makeOutcome()] });
    expect(result.verdict).toBe("effect_verified");
    expect(result.currentValue).toBe(0.9);
  });

  it("returns effect_verified when currentValue exactly equals targetValue", async () => {
    const v = createProposalEffectVerifier({
      store,
      getCurrentValue: async () => 0.8, // exactly equal to targetValue: 0.8
    });
    const [result] = await v.verify({ outcomes: [makeOutcome()] });
    expect(result.verdict).toBe("effect_verified");
  });

  it("writes proposal:effect:verified signal on success", async () => {
    const v = createProposalEffectVerifier({
      store,
      getCurrentValue: async () => 0.9,
    });
    await v.verify({ outcomes: [makeOutcome()] });
    const sigs = await signalsByType(store, "proposal:effect:verified");
    expect(sigs).toHaveLength(1);
  });

  it("does NOT write rollback_candidate on effect_verified", async () => {
    const v = createProposalEffectVerifier({
      store,
      getCurrentValue: async () => 0.9,
    });
    await v.verify({ outcomes: [makeOutcome()] });
    const rbSigs = await signalsByType(store, "proposal:effect:rollback_candidate");
    expect(rbSigs).toHaveLength(0);
  });

  // ── Verdict: effect_failed ────────────────────────────

  it("returns effect_failed when currentValue < targetValue", async () => {
    const v = createProposalEffectVerifier({
      store,
      getCurrentValue: async () => 0.4,
    });
    const [result] = await v.verify({ outcomes: [makeOutcome()] });
    expect(result.verdict).toBe("effect_failed");
    expect(result.currentValue).toBe(0.4);
  });

  it("writes proposal:effect:failed signal on failure", async () => {
    const v = createProposalEffectVerifier({
      store,
      getCurrentValue: async () => 0.4,
    });
    await v.verify({ outcomes: [makeOutcome()] });
    const sigs = await signalsByType(store, "proposal:effect:failed");
    expect(sigs).toHaveLength(1);
  });

  it("writes rollback_candidate signal on effect_failed", async () => {
    const v = createProposalEffectVerifier({
      store,
      getCurrentValue: async () => 0.4,
    });
    await v.verify({ outcomes: [makeOutcome()] });
    const rbSigs = await signalsByType(store, "proposal:effect:rollback_candidate");
    expect(rbSigs).toHaveLength(1);
    const payload = rbSigs[0].payload as { verdict: EffectVerdict; proposalId: string };
    expect(payload.verdict).toBe("effect_failed");
    expect(payload.proposalId).toBe("proposal-abc");
  });

  it("writes 2 signals total on effect_failed (failed + rollback_candidate)", async () => {
    const v = createProposalEffectVerifier({
      store,
      getCurrentValue: async () => 0.4,
    });
    await v.verify({ outcomes: [makeOutcome()] });
    expect(store.signalCount).toBe(2);
  });

  // ── Multiple outcomes ─────────────────────────────────

  it("processes multiple eligible outcomes independently", async () => {
    const outcomes = [
      makeOutcome({
        proposalId: "p1",
        successMetric: { baselineValue: 0, targetValue: 0.8, signalRef: "a.b" },
      }),
      makeOutcome({
        proposalId: "p2",
        successMetric: { baselineValue: 0, targetValue: 0.5, signalRef: "c.d" },
      }),
    ];
    const calls: string[] = [];
    const v = createProposalEffectVerifier({
      store,
      getCurrentValue: async (ref) => {
        calls.push(ref);
        return ref === "a.b" ? 0.9 : 0.2;
      },
    });
    const results = await v.verify({ outcomes });
    expect(results).toHaveLength(2);
    expect(results[0].verdict).toBe("effect_verified");
    expect(results[1].verdict).toBe("effect_failed");
    expect(calls).toEqual(["a.b", "c.d"]);
  });

  // ── Result payload ────────────────────────────────────

  it("result includes proposalId, capability, changeType, successMetric snapshot", async () => {
    const v = createProposalEffectVerifier({
      store,
      getCurrentValue: async () => 0.9,
    });
    const [result] = await v.verify({ outcomes: [makeOutcome()] });
    expect(result.proposalId).toBe("proposal-abc");
    expect(result.capability).toBe("cap-task");
    expect(result.changeType).toBe("minor");
    expect(result.successMetric.baselineValue).toBe(0.5);
    expect(result.successMetric.targetValue).toBe(0.8);
    expect(result.successMetric.signalRef).toBe("task.completion_rate");
  });

  it("result includes verifiedAt ISO 8601 timestamp", async () => {
    const fixedNow = new Date("2026-06-01T12:00:00.000Z");
    const v = createProposalEffectVerifier({
      store,
      getCurrentValue: async () => 0.9,
      clock: () => fixedNow,
    });
    const [result] = await v.verify({ outcomes: [makeOutcome()] });
    expect(result.verifiedAt).toBe("2026-06-01T12:00:00.000Z");
  });

  it("signal timestamp matches clock injection", async () => {
    const fixedNow = new Date("2026-06-01T12:00:00.000Z");
    const v = createProposalEffectVerifier({
      store,
      getCurrentValue: async () => 0.9,
      clock: () => fixedNow,
    });
    await v.verify({ outcomes: [makeOutcome()] });
    const sig = await lastSignal(store);
    expect(sig.timestamp).toEqual(fixedNow);
  });

  // ── Default getCurrentValue (baseline lookup) ─────────

  it("default getCurrentValue parses dot-separated signalRef (entity.metric)", async () => {
    await store.updateBaseline({
      entity: "task",
      metric: "completion_rate",
      value: 0.9,
      calculatedAt: new Date(),
    });
    const [result] = await verifier.verify({
      outcomes: [
        makeOutcome({
          successMetric: {
            signalRef: "task.completion_rate",
            baselineValue: 0.5,
            targetValue: 0.8,
          },
        }),
      ],
    });
    expect(result.currentValue).toBe(0.9);
    expect(result.verdict).toBe("effect_verified");
  });

  it("default getCurrentValue parses colon-separated signalRef (entity:metric)", async () => {
    await store.updateBaseline({
      entity: "order",
      metric: "error_rate",
      value: 0.1,
      calculatedAt: new Date(),
    });
    const [result] = await verifier.verify({
      outcomes: [
        makeOutcome({
          successMetric: { signalRef: "order:error_rate", baselineValue: 0.3, targetValue: 0.05 },
        }),
      ],
    });
    // currentValue=0.1 >= targetValue=0.05 → effect_verified
    expect(result.currentValue).toBe(0.1);
    expect(result.verdict).toBe("effect_verified");
  });

  it("default getCurrentValue returns null when signalRef has no separator", async () => {
    const [result] = await verifier.verify({
      outcomes: [
        makeOutcome({
          successMetric: { signalRef: "noseparator", baselineValue: 0, targetValue: 1 },
        }),
      ],
    });
    expect(result.currentValue).toBeNull();
    expect(result.verdict).toBe("effect_uncertain");
  });

  it("default getCurrentValue returns null when baseline not in store", async () => {
    const [result] = await verifier.verify({
      outcomes: [
        makeOutcome({
          successMetric: { signalRef: "entity.missing_metric", baselineValue: 0, targetValue: 1 },
        }),
      ],
    });
    expect(result.currentValue).toBeNull();
    expect(result.verdict).toBe("effect_uncertain");
  });
});
