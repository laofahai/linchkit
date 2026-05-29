/**
 * Tests for ProposalEffectVerifier (Spec 55 §7.7 Phase 2).
 *
 * Verifies verdict computation, signal writes, rollback_candidate emission,
 * outcome filtering, default signalRef parsing, and verifyThreshold.
 */

import { describe, expect, it } from "bun:test";
import {
  createProposalEffectVerifier,
  type EffectVerificationPayload,
  ProposalEffectVerifier,
} from "../src/engine/proposal-effect-verifier";
import type { ProposalOutcomePayload } from "../src/engine/proposal-outcome-recorder";
import { InMemoryMemoryStore } from "../src/life-system/in-memory-memory-store";
import type { Baseline, Signal } from "../src/types/life-system";

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
    authorType: "human",
    authorId: "user-1",
    outcomeAt: new Date("2026-01-15T10:00:00Z").toISOString(),
    proposalCreatedAt: new Date("2026-01-10T00:00:00Z").toISOString(),
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
          successMetric: { description: "test", baselineValue: 10, targetValue: 20 }, // no signalRef
        }),
      );
      const verifier = new ProposalEffectVerifier({ store });
      expect(await verifier.verifyAll()).toEqual([]);
    });

    it("does not process non-merged outcome signals", async () => {
      const store = makeStore();
      await store.recordSignal({
        type: "proposal:outcome:accepted",
        source: "event_bus",
        timestamp: new Date(),
        payload: {
          proposalId: "prop-a",
          capability: "cap-x",
          changeType: "minor",
          outcome: "accepted",
          authorType: "human",
          authorId: "user-a",
          outcomeAt: new Date().toISOString(),
          proposalCreatedAt: new Date().toISOString(),
          successMetric: {
            description: "test",
            baselineValue: 5,
            targetValue: 50,
            signalRef: "cap-x",
          },
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
          successMetric: {
            description: "test",
            baselineValue: 10,
            targetValue: 80,
            signalRef: "cap-task",
          },
        }),
      );
      const verifier = new ProposalEffectVerifier({ store });
      const results = await verifier.verifyAll();
      expect(results).toHaveLength(1);
      const rec = results[0]!;

      expect(rec.result).toBe("effect_uncertain");
      expect(rec.currentValue).toBeUndefined();
      expect(rec.proposalId).toBe("prop-xyz-00000001");
    });

    it("emits proposal:effect:uncertain signal to store", async () => {
      const store = makeStore();
      await store.recordSignal(
        makeMergedSignal({
          successMetric: {
            description: "test",
            baselineValue: 10,
            targetValue: 80,
            signalRef: "cap-task",
          },
        }),
      );
      const verifier = new ProposalEffectVerifier({ store });
      await verifier.verifyAll();

      const effectSignals = await store.getSignals({ entity: "proposal:effect:uncertain" });
      expect(effectSignals).toHaveLength(1);
      const p = effectSignals[0]!.payload as EffectVerificationPayload;
      expect(p.rollback_candidate).toBe(false);
    });
  });

  // ── verifyAll — effect_uncertain (partial progress) ───────────────────────

  describe("verifyAll — effect_uncertain (partial progress)", () => {
    it("returns effect_uncertain when current is between baseline and 90% target", async () => {
      const store = makeStore();
      await store.recordSignal(
        makeMergedSignal({
          successMetric: {
            description: "test",
            baselineValue: 0,
            targetValue: 100,
            signalRef: "cap-task:success_rate",
          },
        }),
      );
      await store.updateBaseline(makeBaseline("cap-task", "success_rate", 50));
      const verifier = new ProposalEffectVerifier({ store });
      const results = await verifier.verifyAll();
      expect(results).toHaveLength(1);
      const rec = results[0]!;

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
          successMetric: {
            description: "test",
            baselineValue: 0,
            targetValue: 100,
            signalRef: "cap-task",
          },
        }),
      );
      await store.updateBaseline(makeBaseline("cap-task", "value", 95));
      const verifier = new ProposalEffectVerifier({ store });
      const results = await verifier.verifyAll();
      expect(results).toHaveLength(1);
      const rec = results[0]!;

      expect(rec.result).toBe("effect_verified");
      expect(rec.currentValue).toBe(95);
    });

    it("returns effect_verified exactly at the threshold boundary", async () => {
      const store = makeStore();
      await store.recordSignal(
        makeMergedSignal({
          successMetric: {
            description: "test",
            baselineValue: 0,
            targetValue: 100,
            signalRef: "cap-task",
          },
        }),
      );
      await store.updateBaseline(makeBaseline("cap-task", "value", 90));
      const verifier = new ProposalEffectVerifier({ store });
      const results = await verifier.verifyAll();
      expect(results).toHaveLength(1);
      const rec = results[0]!;

      expect(rec.result).toBe("effect_verified");
    });

    it("emits proposal:effect:verified signal with rollback_candidate: false", async () => {
      const store = makeStore();
      await store.recordSignal(
        makeMergedSignal({
          successMetric: {
            description: "test",
            baselineValue: 0,
            targetValue: 100,
            signalRef: "cap-task",
          },
        }),
      );
      await store.updateBaseline(makeBaseline("cap-task", "value", 95));
      const verifier = new ProposalEffectVerifier({ store });
      await verifier.verifyAll();

      const effectSignals = await store.getSignals({ entity: "proposal:effect:verified" });
      expect(effectSignals).toHaveLength(1);
      const p = effectSignals[0]!.payload as EffectVerificationPayload;
      expect(p.rollback_candidate).toBe(false);
    });

    it("respects custom verifyThreshold", async () => {
      const store = makeStore();
      await store.recordSignal(
        makeMergedSignal({
          successMetric: {
            description: "test",
            baselineValue: 0,
            targetValue: 100,
            signalRef: "cap-task",
          },
        }),
      );
      await store.updateBaseline(makeBaseline("cap-task", "value", 70));
      const verifier = new ProposalEffectVerifier({ store, verifyThreshold: 0.6 });
      const results = await verifier.verifyAll();
      expect(results).toHaveLength(1);
      const rec = results[0]!;

      expect(rec.result).toBe("effect_verified");
    });
  });

  // ── verifyAll — effect_failed ─────────────────────────────────────────────

  describe("verifyAll — effect_failed", () => {
    it("returns effect_failed when current <= baselineValue", async () => {
      const store = makeStore();
      await store.recordSignal(
        makeMergedSignal({
          successMetric: {
            description: "test",
            baselineValue: 50,
            targetValue: 80,
            signalRef: "cap-task",
          },
        }),
      );
      await store.updateBaseline(makeBaseline("cap-task", "value", 45));
      const verifier = new ProposalEffectVerifier({ store });
      const results = await verifier.verifyAll();
      expect(results).toHaveLength(1);
      const rec = results[0]!;

      expect(rec.result).toBe("effect_failed");
      expect(rec.currentValue).toBe(45);
    });

    it("returns effect_failed when current equals baselineValue", async () => {
      const store = makeStore();
      await store.recordSignal(
        makeMergedSignal({
          successMetric: {
            description: "test",
            baselineValue: 50,
            targetValue: 80,
            signalRef: "cap-task",
          },
        }),
      );
      await store.updateBaseline(makeBaseline("cap-task", "value", 50));
      const verifier = new ProposalEffectVerifier({ store });
      const results = await verifier.verifyAll();
      expect(results).toHaveLength(1);
      const rec = results[0]!;

      expect(rec.result).toBe("effect_failed");
    });

    it("emits proposal:effect:failed signal with rollback_candidate: true", async () => {
      const store = makeStore();
      await store.recordSignal(
        makeMergedSignal({
          successMetric: {
            description: "test",
            baselineValue: 50,
            targetValue: 80,
            signalRef: "cap-task",
          },
        }),
      );
      await store.updateBaseline(makeBaseline("cap-task", "value", 40));
      const verifier = new ProposalEffectVerifier({ store });
      await verifier.verifyAll();

      const failedSignals = await store.getSignals({ entity: "proposal:effect:failed" });
      expect(failedSignals).toHaveLength(1);
      const p = failedSignals[0]!.payload as EffectVerificationPayload;
      expect(p.rollback_candidate).toBe(true);
      expect(p.proposalId).toBe("prop-xyz-00000001");
    });

    it("threads mergedSha from the merged outcome payload into the record and failed signal", async () => {
      // Slice B: the merged commit SHA captured at graduation must survive the
      // outcome → effect-verification hop so it can reach the rollback translator.
      const store = makeStore();
      await store.recordSignal(
        makeMergedSignal({
          mergedSha: "cafebabe9999",
          successMetric: {
            description: "test",
            baselineValue: 50,
            targetValue: 80,
            signalRef: "cap-task",
          },
        }),
      );
      await store.updateBaseline(makeBaseline("cap-task", "value", 40));
      const verifier = new ProposalEffectVerifier({ store });
      const results = await verifier.verifyAll();
      const record = results[0];
      if (!record) throw new Error("expected one verification record");
      expect(record.mergedSha).toBe("cafebabe9999");

      const failedSignals = await store.getSignals({ entity: "proposal:effect:failed" });
      const failedSignal = failedSignals[0];
      if (!failedSignal) throw new Error("expected one failed signal");
      const p = failedSignal.payload as EffectVerificationPayload;
      expect(p.mergedSha).toBe("cafebabe9999");
    });
  });

  // ── verifyAll — decreasing goals ──────────────────────────────────────────

  describe("verifyAll — decreasing goals", () => {
    // baseline 100 → target 50, default threshold 0.9 → requiredValue 55.

    it("returns effect_verified when current overshoots below the target", async () => {
      const store = makeStore();
      await store.recordSignal(
        makeMergedSignal({
          successMetric: {
            description: "test",
            baselineValue: 100,
            targetValue: 50,
            signalRef: "cap-task",
          },
        }),
      );
      await store.updateBaseline(makeBaseline("cap-task", "value", 40));
      const verifier = new ProposalEffectVerifier({ store });
      const results = await verifier.verifyAll();
      expect(results).toHaveLength(1);
      const rec = results[0]!;

      expect(rec.result).toBe("effect_verified");
      expect(rec.currentValue).toBe(40);
    });

    it("returns effect_verified exactly at the required threshold", async () => {
      const store = makeStore();
      await store.recordSignal(
        makeMergedSignal({
          successMetric: {
            description: "test",
            baselineValue: 100,
            targetValue: 50,
            signalRef: "cap-task",
          },
        }),
      );
      await store.updateBaseline(makeBaseline("cap-task", "value", 55));
      const verifier = new ProposalEffectVerifier({ store });
      const results = await verifier.verifyAll();
      const rec = results[0]!;

      expect(rec.result).toBe("effect_verified");
    });

    it("returns effect_uncertain with partial progress toward target", async () => {
      const store = makeStore();
      await store.recordSignal(
        makeMergedSignal({
          successMetric: {
            description: "test",
            baselineValue: 100,
            targetValue: 50,
            signalRef: "cap-task",
          },
        }),
      );
      await store.updateBaseline(makeBaseline("cap-task", "value", 70));
      const verifier = new ProposalEffectVerifier({ store });
      const results = await verifier.verifyAll();
      const rec = results[0]!;

      expect(rec.result).toBe("effect_uncertain");
    });

    it("returns effect_failed when the metric stays flat at baseline", async () => {
      const store = makeStore();
      await store.recordSignal(
        makeMergedSignal({
          successMetric: {
            description: "test",
            baselineValue: 100,
            targetValue: 50,
            signalRef: "cap-task",
          },
        }),
      );
      await store.updateBaseline(makeBaseline("cap-task", "value", 100));
      const verifier = new ProposalEffectVerifier({ store });
      const results = await verifier.verifyAll();
      const rec = results[0]!;

      expect(rec.result).toBe("effect_failed");
    });

    it("returns effect_failed when the metric moves the wrong way", async () => {
      const store = makeStore();
      await store.recordSignal(
        makeMergedSignal({
          successMetric: {
            description: "test",
            baselineValue: 100,
            targetValue: 50,
            signalRef: "cap-task",
          },
        }),
      );
      await store.updateBaseline(makeBaseline("cap-task", "value", 120));
      const verifier = new ProposalEffectVerifier({ store });
      const results = await verifier.verifyAll();
      const rec = results[0]!;

      expect(rec.result).toBe("effect_failed");
    });

    it("returns effect_uncertain when target equals baseline (no measurable gap)", async () => {
      const store = makeStore();
      await store.recordSignal(
        makeMergedSignal({
          successMetric: {
            description: "test",
            baselineValue: 50,
            targetValue: 50,
            signalRef: "cap-task",
          },
        }),
      );
      await store.updateBaseline(makeBaseline("cap-task", "value", 50));
      const verifier = new ProposalEffectVerifier({ store });
      const results = await verifier.verifyAll();
      const rec = results[0]!;

      expect(rec.result).toBe("effect_uncertain");
    });
  });

  // ── signalRef parsing ─────────────────────────────────────────────────────

  describe("signalRef parsing", () => {
    it("parses bare entity ref (defaults metric to 'value')", async () => {
      const store = makeStore();
      await store.recordSignal(
        makeMergedSignal({
          successMetric: {
            description: "test",
            baselineValue: 0,
            targetValue: 100,
            signalRef: "my-cap",
          },
        }),
      );
      await store.updateBaseline(makeBaseline("my-cap", "value", 95));
      const verifier = new ProposalEffectVerifier({ store });
      const results = await verifier.verifyAll();
      expect(results).toHaveLength(1);
      const rec = results[0]!;

      expect(rec.result).toBe("effect_verified");
      expect(rec.signalRef).toBe("my-cap");
    });

    it("parses entity:metric ref correctly", async () => {
      const store = makeStore();
      await store.recordSignal(
        makeMergedSignal({
          successMetric: {
            description: "test",
            baselineValue: 0,
            targetValue: 100,
            signalRef: "cap-orders:fill_rate",
          },
        }),
      );
      await store.updateBaseline(makeBaseline("cap-orders", "fill_rate", 95));
      const verifier = new ProposalEffectVerifier({ store });
      const results = await verifier.verifyAll();
      expect(results).toHaveLength(1);
      const rec = results[0]!;

      expect(rec.result).toBe("effect_verified");
      expect(rec.signalRef).toBe("cap-orders:fill_rate");
    });

    it("treats only the first colon as the entity/metric separator", async () => {
      const store = makeStore();
      await store.recordSignal(
        makeMergedSignal({
          successMetric: {
            description: "test",
            baselineValue: 0,
            targetValue: 100,
            signalRef: "cap-foo:bar:baz",
          },
        }),
      );
      await store.updateBaseline(makeBaseline("cap-foo", "bar:baz", 95));
      const verifier = new ProposalEffectVerifier({ store });
      const results = await verifier.verifyAll();
      expect(results).toHaveLength(1);
      const rec = results[0]!;

      expect(rec.result).toBe("effect_verified");
    });

    it("parses entity.metric dot-separated ref correctly", async () => {
      const store = makeStore();
      await store.recordSignal(
        makeMergedSignal({
          successMetric: {
            description: "test",
            baselineValue: 0,
            targetValue: 100,
            signalRef: "orders.conversionRate",
          },
        }),
      );
      await store.updateBaseline(makeBaseline("orders", "conversionRate", 95));
      const verifier = new ProposalEffectVerifier({ store });
      const results = await verifier.verifyAll();
      expect(results).toHaveLength(1);
      const rec = results[0]!;

      expect(rec.result).toBe("effect_verified");
      expect(rec.signalRef).toBe("orders.conversionRate");
    });

    it("prefers colon over dot when both present", async () => {
      const store = makeStore();
      await store.recordSignal(
        makeMergedSignal({
          successMetric: {
            description: "test",
            baselineValue: 0,
            targetValue: 100,
            signalRef: "cap-orders:fill.rate",
          },
        }),
      );
      await store.updateBaseline(makeBaseline("cap-orders", "fill.rate", 95));
      const verifier = new ProposalEffectVerifier({ store });
      const results = await verifier.verifyAll();
      expect(results).toHaveLength(1);
      const rec = results[0]!;

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
          successMetric: {
            description: "test",
            baselineValue: 0,
            targetValue: 100,
            signalRef: "cap-a",
          },
        }),
      );
      await store.recordSignal(
        makeMergedSignal({
          proposalId: "prop-b",
          successMetric: {
            description: "test",
            baselineValue: 0,
            targetValue: 100,
            signalRef: "cap-b",
          },
        }),
      );
      await store.updateBaseline(makeBaseline("cap-a", "value", 95));
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
          successMetric: {
            description: "test",
            baselineValue: 0,
            targetValue: 100,
            signalRef: "cap-x",
          },
        }),
      );
      await store.recordSignal(
        makeMergedSignal({
          proposalId: "prop-2",
          successMetric: {
            description: "test",
            baselineValue: 0,
            targetValue: 100,
            signalRef: "cap-y",
          },
        }),
      );
      await store.updateBaseline(makeBaseline("cap-x", "value", 95));
      await store.updateBaseline(makeBaseline("cap-y", "value", 0));

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
      await store.recordSignal({
        type: "proposal:outcome:merged",
        source: "event_bus",
        timestamp: new Date("2026-01-01T00:00:00Z"),
        payload: {
          proposalId: "prop-old",
          capability: "cap-z",
          changeType: "minor",
          outcome: "merged",
          authorType: "human",
          authorId: "user-1",
          outcomeAt: new Date("2026-01-01T00:00:00Z").toISOString(),
          proposalCreatedAt: new Date("2025-12-01T00:00:00Z").toISOString(),
          successMetric: {
            description: "test",
            baselineValue: 0,
            targetValue: 100,
            signalRef: "cap-z",
          },
        } satisfies ProposalOutcomePayload,
      });
      await store.recordSignal({
        type: "proposal:outcome:merged",
        source: "event_bus",
        timestamp: new Date("2026-02-01T00:00:00Z"),
        payload: {
          proposalId: "prop-new",
          capability: "cap-z",
          changeType: "minor",
          outcome: "merged",
          authorType: "human",
          authorId: "user-1",
          outcomeAt: new Date("2026-02-01T00:00:00Z").toISOString(),
          proposalCreatedAt: new Date("2026-01-15T00:00:00Z").toISOString(),
          successMetric: {
            description: "test",
            baselineValue: 0,
            targetValue: 100,
            signalRef: "cap-z",
          },
        } satisfies ProposalOutcomePayload,
      });

      const verifier = new ProposalEffectVerifier({ store });
      const results = await verifier.verifyAll({ since: new Date("2026-01-20T00:00:00Z") });

      expect(results).toHaveLength(1);
      expect(results[0]!.proposalId).toBe("prop-new");
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
          successMetric: {
            description: "test",
            baselineValue: 10,
            targetValue: 90,
            signalRef: "cap-task:rate",
          },
        }),
      );
      await store.updateBaseline(makeBaseline("cap-task", "rate", 85));
      const verifier = new ProposalEffectVerifier({ store });
      const results = await verifier.verifyAll();
      expect(results).toHaveLength(1);
      const rec = results[0]!;

      expect(rec.proposalId).toBe("prop-abc");
      expect(rec.capability).toBe("cap-task");
      expect(rec.signalRef).toBe("cap-task:rate");
      expect(rec.baselineValue).toBe(10);
      expect(rec.targetValue).toBe(90);
      expect(rec.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });
});
