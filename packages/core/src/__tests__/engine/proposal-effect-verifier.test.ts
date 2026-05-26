import { describe, expect, it } from "bun:test";
import {
  createProposalEffectVerifier,
  type EffectVerificationPayload,
  ProposalEffectVerifier,
} from "../../engine/proposal-effect-verifier";
import type { ProposalOutcomePayload } from "../../engine/proposal-outcome-recorder";
import { InMemoryMemoryStore } from "../../life-system/in-memory-memory-store";
import type { Baseline, Signal } from "../../types/life-system";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeStore(): InMemoryMemoryStore {
  return new InMemoryMemoryStore();
}

function makeMergedSignal(overrides: Partial<ProposalOutcomePayload> = {}): Signal {
  const payload: ProposalOutcomePayload = {
    proposalId: "prop-xyz-00000001",
    capability: "cap-task",
    changeType: "minor",
    outcome: "merged",
    recordedAt: new Date("2026-01-15T10:00:00Z").toISOString(),
    ...overrides,
  };
  return {
    type: "proposal:outcome:merged",
    source: "event_bus",
    timestamp: new Date("2026-01-15T10:00:00Z"),
    payload,
  };
}

function makeBaseline(entity: string, metric: string, value: number): Baseline {
  return { entity, metric, value, calculatedAt: new Date("2026-01-20T00:00:00Z") };
}

// ── ProposalEffectVerifier — factory ─────────────────────────────────────────

describe("ProposalEffectVerifier", () => {
  describe("factory", () => {
    it("createProposalEffectVerifier returns a ProposalEffectVerifier", () => {
      const verifier = createProposalEffectVerifier({ store: makeStore() });
      expect(verifier).toBeInstanceOf(ProposalEffectVerifier);
    });
  });

  // ── verifyAll — skip conditions ───────────────────────────────────────────

  describe("verifyAll — skip conditions", () => {
    it("returns empty array when no merged outcome signals exist", async () => {
      const store = makeStore();
      const verifier = new ProposalEffectVerifier({ store });
      expect(await verifier.verifyAll()).toEqual([]);
    });

    it("skips merged signals without successMetric", async () => {
      const store = makeStore();
      await store.recordSignal(makeMergedSignal()); // no successMetric
      const verifier = new ProposalEffectVerifier({ store });
      expect(await verifier.verifyAll()).toEqual([]);
    });

    it("skips merged signals with successMetric but without signalRef", async () => {
      const store = makeStore();
      await store.recordSignal(
        makeMergedSignal({
          successMetric: { baselineValue: 10, targetValue: 20 }, // no signalRef
        }),
      );
      const verifier = new ProposalEffectVerifier({ store });
      expect(await verifier.verifyAll()).toEqual([]);
    });

    it("does not process non-merged outcome signals", async () => {
      const store = makeStore();
      // Record an "accepted" outcome (not "merged") with successMetric
      await store.recordSignal({
        type: "proposal:outcome:accepted",
        source: "event_bus",
        timestamp: new Date(),
        payload: {
          proposalId: "prop-a",
          capability: "cap-x",
          changeType: "minor",
          outcome: "accepted",
          recordedAt: new Date().toISOString(),
          successMetric: { baselineValue: 5, targetValue: 50, signalRef: "cap-x" },
        } satisfies ProposalOutcomePayload,
      });
      const verifier = new ProposalEffectVerifier({ store });
      expect(await verifier.verifyAll()).toEqual([]);
    });
  });

  // ── verifyAll — effect_uncertain (no baseline) ────────────────────────────

  describe("verifyAll — effect_uncertain (no baseline)", () => {
    it("returns effect_uncertain when signalRef has no stored baseline", async () => {
      const store = makeStore();
      await store.recordSignal(
        makeMergedSignal({
          successMetric: { baselineValue: 10, targetValue: 80, signalRef: "cap-task" },
        }),
      );
      const verifier = new ProposalEffectVerifier({ store });
      const [rec] = await verifier.verifyAll();

      expect(rec.result).toBe("effect_uncertain");
      expect(rec.currentValue).toBeUndefined();
      expect(rec.proposalId).toBe("prop-xyz-00000001");
    });

    it("emits proposal:effect:uncertain signal to store", async () => {
      const store = makeStore();
      await store.recordSignal(
        makeMergedSignal({
          successMetric: { baselineValue: 10, targetValue: 80, signalRef: "cap-task" },
        }),
      );
      const verifier = new ProposalEffectVerifier({ store });
      await verifier.verifyAll();

      const effectSignals = await store.getSignals({ entity: "proposal:effect:uncertain" });
      expect(effectSignals).toHaveLength(1);
      const p = effectSignals[0].payload as EffectVerificationPayload;
      expect(p.rollback_candidate).toBe(false);
    });
  });

  // ── verifyAll — effect_uncertain (partial progress) ───────────────────────

  describe("verifyAll — effect_uncertain (partial progress)", () => {
    it("returns effect_uncertain when current is between baseline and 90% target", async () => {
      const store = makeStore();
      await store.recordSignal(
        makeMergedSignal({
          successMetric: { baselineValue: 0, targetValue: 100, signalRef: "cap-task:success_rate" },
        }),
      );
      await store.updateBaseline(makeBaseline("cap-task", "success_rate", 50)); // 50% progress, < 90%
      const verifier = new ProposalEffectVerifier({ store });
      const [rec] = await verifier.verifyAll();

      expect(rec.result).toBe("effect_uncertain");
      expect(rec.currentValue).toBe(50);
    });
  });

  // ── verifyAll — effect_verified ───────────────────────────────────────────

  describe("verifyAll — effect_verified", () => {
    it("returns effect_verified when current >= 90% of target gap (default threshold)", async () => {
      const store = makeStore();
      await store.recordSignal(
        makeMergedSignal({
          successMetric: { baselineValue: 0, targetValue: 100, signalRef: "cap-task" },
        }),
      );
      await store.updateBaseline(makeBaseline("cap-task", "value", 95)); // 95% > 90%
      const verifier = new ProposalEffectVerifier({ store });
      const [rec] = await verifier.verifyAll();

      expect(rec.result).toBe("effect_verified");
      expect(rec.currentValue).toBe(95);
    });

    it("returns effect_verified exactly at the threshold boundary", async () => {
      const store = makeStore();
      await store.recordSignal(
        makeMergedSignal({
          successMetric: { baselineValue: 0, targetValue: 100, signalRef: "cap-task" },
        }),
      );
      await store.updateBaseline(makeBaseline("cap-task", "value", 90)); // exactly 90%
      const verifier = new ProposalEffectVerifier({ store });
      const [rec] = await verifier.verifyAll();

      expect(rec.result).toBe("effect_verified");
    });

    it("emits proposal:effect:verified signal with rollback_candidate: false", async () => {
      const store = makeStore();
      await store.recordSignal(
        makeMergedSignal({
          successMetric: { baselineValue: 0, targetValue: 100, signalRef: "cap-task" },
        }),
      );
      await store.updateBaseline(makeBaseline("cap-task", "value", 95));
      const verifier = new ProposalEffectVerifier({ store });
      await verifier.verifyAll();

      const effectSignals = await store.getSignals({ entity: "proposal:effect:verified" });
      expect(effectSignals).toHaveLength(1);
      const p = effectSignals[0].payload as EffectVerificationPayload;
      expect(p.rollback_candidate).toBe(false);
    });

    it("respects custom verifyThreshold", async () => {
      const store = makeStore();
      await store.recordSignal(
        makeMergedSignal({
          successMetric: { baselineValue: 0, targetValue: 100, signalRef: "cap-task" },
        }),
      );
      await store.updateBaseline(makeBaseline("cap-task", "value", 70)); // 70%
      // With threshold 0.6, 70% qualifies as verified
      const verifier = new ProposalEffectVerifier({ store, verifyThreshold: 0.6 });
      const [rec] = await verifier.verifyAll();

      expect(rec.result).toBe("effect_verified");
    });
  });

  // ── verifyAll — effect_failed ─────────────────────────────────────────────

  describe("verifyAll — effect_failed", () => {
    it("returns effect_failed when current <= baselineValue", async () => {
      const store = makeStore();
      await store.recordSignal(
        makeMergedSignal({
          successMetric: { baselineValue: 50, targetValue: 80, signalRef: "cap-task" },
        }),
      );
      await store.updateBaseline(makeBaseline("cap-task", "value", 45)); // below baseline
      const verifier = new ProposalEffectVerifier({ store });
      const [rec] = await verifier.verifyAll();

      expect(rec.result).toBe("effect_failed");
      expect(rec.currentValue).toBe(45);
    });

    it("returns effect_failed when current equals baselineValue", async () => {
      const store = makeStore();
      await store.recordSignal(
        makeMergedSignal({
          successMetric: { baselineValue: 50, targetValue: 80, signalRef: "cap-task" },
        }),
      );
      await store.updateBaseline(makeBaseline("cap-task", "value", 50)); // exactly at baseline
      const verifier = new ProposalEffectVerifier({ store });
      const [rec] = await verifier.verifyAll();

      expect(rec.result).toBe("effect_failed");
    });

    it("emits proposal:effect:failed signal with rollback_candidate: true", async () => {
      const store = makeStore();
      await store.recordSignal(
        makeMergedSignal({
          successMetric: { baselineValue: 50, targetValue: 80, signalRef: "cap-task" },
        }),
      );
      await store.updateBaseline(makeBaseline("cap-task", "value", 40));
      const verifier = new ProposalEffectVerifier({ store });
      await verifier.verifyAll();

      const failedSignals = await store.getSignals({ entity: "proposal:effect:failed" });
      expect(failedSignals).toHaveLength(1);
      const p = failedSignals[0].payload as EffectVerificationPayload;
      expect(p.rollback_candidate).toBe(true);
      expect(p.proposalId).toBe("prop-xyz-00000001");
    });
  });

  // ── signalRef parsing ─────────────────────────────────────────────────────

  describe("signalRef parsing", () => {
    it("parses bare entity ref (defaults metric to 'value')", async () => {
      const store = makeStore();
      await store.recordSignal(
        makeMergedSignal({
          successMetric: { baselineValue: 0, targetValue: 100, signalRef: "my-cap" },
        }),
      );
      await store.updateBaseline(makeBaseline("my-cap", "value", 95));
      const verifier = new ProposalEffectVerifier({ store });
      const [rec] = await verifier.verifyAll();

      expect(rec.result).toBe("effect_verified");
      expect(rec.signalRef).toBe("my-cap");
    });

    it("parses entity:metric ref correctly", async () => {
      const store = makeStore();
      await store.recordSignal(
        makeMergedSignal({
          successMetric: { baselineValue: 0, targetValue: 100, signalRef: "cap-orders:fill_rate" },
        }),
      );
      await store.updateBaseline(makeBaseline("cap-orders", "fill_rate", 95));
      const verifier = new ProposalEffectVerifier({ store });
      const [rec] = await verifier.verifyAll();

      expect(rec.result).toBe("effect_verified");
      expect(rec.signalRef).toBe("cap-orders:fill_rate");
    });

    it("treats only the first colon as the entity/metric separator", async () => {
      const store = makeStore();
      // signalRef with two colons — entity is "cap-foo", metric is "bar:baz"
      await store.recordSignal(
        makeMergedSignal({
          successMetric: { baselineValue: 0, targetValue: 100, signalRef: "cap-foo:bar:baz" },
        }),
      );
      await store.updateBaseline(makeBaseline("cap-foo", "bar:baz", 95));
      const verifier = new ProposalEffectVerifier({ store });
      const [rec] = await verifier.verifyAll();

      expect(rec.result).toBe("effect_verified");
    });
  });

  // ── verifyAll — multiple proposals ───────────────────────────────────────

  describe("verifyAll — multiple proposals", () => {
    it("processes multiple merged signals and returns one record each", async () => {
      const store = makeStore();
      await store.recordSignal(
        makeMergedSignal({
          proposalId: "prop-a",
          successMetric: { baselineValue: 0, targetValue: 100, signalRef: "cap-a" },
        }),
      );
      await store.recordSignal(
        makeMergedSignal({
          proposalId: "prop-b",
          successMetric: { baselineValue: 0, targetValue: 100, signalRef: "cap-b" },
        }),
      );
      await store.updateBaseline(makeBaseline("cap-a", "value", 95));
      // cap-b has no baseline → uncertain
      const verifier = new ProposalEffectVerifier({ store });
      const results = await verifier.verifyAll();

      expect(results).toHaveLength(2);
      const propA = results.find((r) => r.proposalId === "prop-a");
      const propB = results.find((r) => r.proposalId === "prop-b");
      expect(propA?.result).toBe("effect_verified");
      expect(propB?.result).toBe("effect_uncertain");
    });

    it("emits one verification signal per processed proposal", async () => {
      const store = makeStore();
      await store.recordSignal(
        makeMergedSignal({
          proposalId: "prop-1",
          successMetric: { baselineValue: 0, targetValue: 100, signalRef: "cap-x" },
        }),
      );
      await store.recordSignal(
        makeMergedSignal({
          proposalId: "prop-2",
          successMetric: { baselineValue: 0, targetValue: 100, signalRef: "cap-y" },
        }),
      );
      await store.updateBaseline(makeBaseline("cap-x", "value", 95));
      await store.updateBaseline(makeBaseline("cap-y", "value", 0)); // at baseline → effect_failed

      const verifier = new ProposalEffectVerifier({ store });
      await verifier.verifyAll();

      const verifiedSigs = await store.getSignals({ entity: "proposal:effect:verified" });
      const failedSigs = await store.getSignals({ entity: "proposal:effect:failed" });
      expect(verifiedSigs).toHaveLength(1);
      expect(failedSigs).toHaveLength(1);
    });
  });

  // ── verifyAll — since filter ──────────────────────────────────────────────

  describe("verifyAll — since filter", () => {
    it("only processes signals recorded at or after the since date", async () => {
      const store = makeStore();
      // Old signal (before cutoff)
      await store.recordSignal({
        type: "proposal:outcome:merged",
        source: "event_bus",
        timestamp: new Date("2026-01-01T00:00:00Z"),
        payload: {
          proposalId: "prop-old",
          capability: "cap-z",
          changeType: "minor",
          outcome: "merged",
          recordedAt: new Date("2026-01-01T00:00:00Z").toISOString(),
          successMetric: { baselineValue: 0, targetValue: 100, signalRef: "cap-z" },
        } satisfies ProposalOutcomePayload,
      });
      // New signal (after cutoff)
      await store.recordSignal({
        type: "proposal:outcome:merged",
        source: "event_bus",
        timestamp: new Date("2026-02-01T00:00:00Z"),
        payload: {
          proposalId: "prop-new",
          capability: "cap-z",
          changeType: "minor",
          outcome: "merged",
          recordedAt: new Date("2026-02-01T00:00:00Z").toISOString(),
          successMetric: { baselineValue: 0, targetValue: 100, signalRef: "cap-z" },
        } satisfies ProposalOutcomePayload,
      });

      const verifier = new ProposalEffectVerifier({ store });
      const results = await verifier.verifyAll({ since: new Date("2026-01-20T00:00:00Z") });

      expect(results).toHaveLength(1);
      expect(results[0].proposalId).toBe("prop-new");
    });
  });

  // ── EffectVerificationRecord fields ──────────────────────────────────────

  describe("EffectVerificationRecord fields", () => {
    it("record contains proposalId, capability, signalRef, baselineValue, targetValue, verifiedAt", async () => {
      const store = makeStore();
      await store.recordSignal(
        makeMergedSignal({
          proposalId: "prop-abc",
          capability: "cap-task",
          successMetric: { baselineValue: 10, targetValue: 90, signalRef: "cap-task:rate" },
        }),
      );
      await store.updateBaseline(makeBaseline("cap-task", "rate", 85));
      const verifier = new ProposalEffectVerifier({ store });
      const [rec] = await verifier.verifyAll();

      expect(rec.proposalId).toBe("prop-abc");
      expect(rec.capability).toBe("cap-task");
      expect(rec.signalRef).toBe("cap-task:rate");
      expect(rec.baselineValue).toBe(10);
      expect(rec.targetValue).toBe(90);
      expect(rec.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });
});
