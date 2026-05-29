/**
 * Tests for RollbackInsightEmitter (Spec 55 §7.7 Phase 2).
 *
 * Verifies that proposal:effect:failed signals carrying rollback_candidate
 * are surfaced as rollback Insights, that non-candidate / non-failed signals
 * are skipped, that emission is idempotent across calls, that the Insight
 * carries the correct tag / entity / summary / evidence, and that the `since`
 * filter is respected.
 */

import { describe, expect, it } from "bun:test";
import type { EffectVerificationPayload } from "../src/engine/proposal-effect-verifier";
import {
  createRollbackInsightEmitter,
  RollbackInsightEmitter,
} from "../src/engine/rollback-insight-emitter";
import { InMemoryMemoryStore } from "../src/life-system/in-memory-memory-store";
import type { Signal } from "../src/types/life-system";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Return the first element, asserting it exists — avoids non-null assertions. */
function first<T>(arr: readonly T[]): T {
  const [head] = arr;
  if (head === undefined) throw new Error("expected at least one element");
  return head;
}

function makeStore(): InMemoryMemoryStore {
  return new InMemoryMemoryStore();
}

function makeFailedPayload(
  overrides: Partial<EffectVerificationPayload> = {},
): EffectVerificationPayload {
  return {
    proposalId: "prop-xyz-00000001",
    capability: "cap-task",
    signalRef: "cap-task:success_rate",
    baselineValue: 50,
    targetValue: 80,
    currentValue: 45,
    result: "effect_failed",
    verifiedAt: new Date("2026-01-20T00:00:00Z").toISOString(),
    rollback_candidate: true,
    ...overrides,
  };
}

function makeFailedSignal(
  overrides: Partial<EffectVerificationPayload> = {},
  timestamp = new Date("2026-01-20T00:00:00Z"),
): Signal {
  return {
    type: "proposal:effect:failed",
    source: "event_bus",
    timestamp,
    payload: makeFailedPayload(overrides),
  };
}

// ── factory ────────────────────────────────────────────────────────────────

describe("RollbackInsightEmitter", () => {
  describe("factory", () => {
    it("createRollbackInsightEmitter returns a RollbackInsightEmitter", () => {
      const emitter = createRollbackInsightEmitter({ store: makeStore() });
      expect(emitter).toBeInstanceOf(RollbackInsightEmitter);
    });
  });

  // ── emitAll — happy path ───────────────────────────────────────────────────

  describe("emitAll — emits rollback insight", () => {
    it("returns empty array when no effect_failed signals exist", async () => {
      const emitter = new RollbackInsightEmitter({ store: makeStore() });
      expect(await emitter.emitAll()).toEqual([]);
    });

    it("emits one rollback Insight for an effect_failed signal with rollback_candidate=true", async () => {
      const store = makeStore();
      await store.recordSignal(makeFailedSignal());
      const emitter = new RollbackInsightEmitter({ store });
      const insights = await emitter.emitAll();

      expect(insights).toHaveLength(1);
      const insight = first(insights);
      expect(insight.type).toBe("anomaly");
      expect(insight.tags).toContain("rollback_candidate");
      expect(insight.id).toBe("rollback-insight:prop-xyz-00000001");
    });

    it("scopes the Insight to the proposal's capability/entity", async () => {
      const store = makeStore();
      await store.recordSignal(makeFailedSignal());
      const emitter = new RollbackInsightEmitter({ store });
      const insight = first(await emitter.emitAll());

      expect(insight.entity).toBe("cap-task");
    });

    it("summary names the capability, proposalId and the unmet metric", async () => {
      const store = makeStore();
      await store.recordSignal(makeFailedSignal());
      const emitter = new RollbackInsightEmitter({ store });
      const insight = first(await emitter.emitAll());

      expect(insight.summary).toContain("cap-task");
      expect(insight.summary).toContain("prop-xyz-00000001");
      expect(insight.summary).toContain("cap-task:success_rate");
      // baseline → target vs current
      expect(insight.summary).toContain("50");
      expect(insight.summary).toContain("80");
      expect(insight.summary).toContain("45");
    });

    it("evidence carries the effect_failed signal plus the verification context", async () => {
      const store = makeStore();
      await store.recordSignal(makeFailedSignal());
      const emitter = new RollbackInsightEmitter({ store });
      const insight = first(await emitter.emitAll());

      expect(insight.evidence.signals).toHaveLength(1);
      const sig = first(insight.evidence.signals);
      expect(sig.value).toBe(45);
      expect(sig.baseline).toBe(50);

      expect(insight.evidence.context).toMatchObject({
        proposalId: "prop-xyz-00000001",
        capability: "cap-task",
        signalRef: "cap-task:success_rate",
        baselineValue: 50,
        targetValue: 80,
        currentValue: 45,
      });
    });

    it("threads mergedSha from the payload into the insight evidence context", async () => {
      // Slice B: the merged commit SHA must survive the verifier → emitter hop so
      // the rollback translator can stamp it on the revert change's revertSha.
      const store = makeStore();
      await store.recordSignal(makeFailedSignal({ mergedSha: "deadbeef1234" }));
      const emitter = new RollbackInsightEmitter({ store });
      const insight = first(await emitter.emitAll());

      expect(insight.evidence.context).toMatchObject({ mergedSha: "deadbeef1234" });
    });

    it("carries mergedSha=undefined when the payload had no SHA", async () => {
      const store = makeStore();
      await store.recordSignal(makeFailedSignal());
      const emitter = new RollbackInsightEmitter({ store });
      const insight = first(await emitter.emitAll());

      expect((insight.evidence.context as { mergedSha?: string }).mergedSha).toBeUndefined();
    });

    it("sets deterministic confidence/impact/causality/createdAt", async () => {
      const store = makeStore();
      await store.recordSignal(makeFailedSignal());
      const emitter = new RollbackInsightEmitter({ store });
      const insight = first(await emitter.emitAll());

      expect(insight.impact).toBe("high");
      expect(insight.causality).toBe("causal");
      expect(insight.confidence).toBeGreaterThan(0);
      expect(insight.confidence).toBeLessThanOrEqual(1);
      // createdAt derives from the signal's verifiedAt, not Date.now()
      expect(insight.createdAt.toISOString()).toBe("2026-01-20T00:00:00.000Z");
    });

    it("falls back to the signal timestamp when verifiedAt is missing or invalid", async () => {
      const store = makeStore();
      const signalTs = new Date("2026-03-15T12:00:00Z");
      // verifiedAt cast to a deliberately invalid value to exercise the fallback.
      await store.recordSignal(
        makeFailedSignal({ verifiedAt: "not-a-date" as unknown as string }, signalTs),
      );
      const emitter = new RollbackInsightEmitter({ store });
      const insight = first(await emitter.emitAll());

      // createdAt and the evidence signal timestamp fall back to the signal ts.
      expect(Number.isNaN(insight.createdAt.getTime())).toBe(false);
      expect(insight.createdAt.toISOString()).toBe(signalTs.toISOString());
      const sig = first(insight.evidence.signals);
      expect(Number.isNaN(sig.timestamp.getTime())).toBe(false);
      expect(sig.timestamp.toISOString()).toBe(signalTs.toISOString());
    });
  });

  // ── emitAll — skip conditions ──────────────────────────────────────────────

  describe("emitAll — skip conditions", () => {
    it("skips effect_failed signals without rollback_candidate", async () => {
      const store = makeStore();
      await store.recordSignal(
        makeFailedSignal({ rollback_candidate: false, result: "effect_failed" }),
      );
      const emitter = new RollbackInsightEmitter({ store });
      expect(await emitter.emitAll()).toEqual([]);
    });

    it("does not read non-failed effect signals", async () => {
      const store = makeStore();
      // A verified signal must never be queried by the emitter — but even if it
      // somehow shared the failed type, rollback_candidate=false guards it.
      await store.recordSignal({
        type: "proposal:effect:verified",
        source: "event_bus",
        timestamp: new Date("2026-01-20T00:00:00Z"),
        payload: makeFailedPayload({ result: "effect_verified", rollback_candidate: false }),
      });
      const emitter = new RollbackInsightEmitter({ store });
      expect(await emitter.emitAll()).toEqual([]);
    });

    it("skips signals whose payload is missing", async () => {
      const store = makeStore();
      await store.recordSignal({
        type: "proposal:effect:failed",
        source: "event_bus",
        timestamp: new Date("2026-01-20T00:00:00Z"),
        payload: null,
      });
      const emitter = new RollbackInsightEmitter({ store });
      expect(await emitter.emitAll()).toEqual([]);
    });
  });

  // ── emitAll — idempotency ──────────────────────────────────────────────────

  describe("emitAll — idempotency", () => {
    it("does not re-emit a rollback Insight for the same proposalId across calls", async () => {
      const store = makeStore();
      await store.recordSignal(makeFailedSignal());
      const emitter = new RollbackInsightEmitter({ store });

      const first = await emitter.emitAll();
      expect(first).toHaveLength(1);

      // Second call: same failed signal still in the store, but already emitted.
      const second = await emitter.emitAll();
      expect(second).toEqual([]);
    });

    it("dedups duplicate effect_failed signals for the same proposalId within a single call", async () => {
      const store = makeStore();
      await store.recordSignal(makeFailedSignal());
      await store.recordSignal(makeFailedSignal()); // duplicate
      const emitter = new RollbackInsightEmitter({ store });

      const insights = await emitter.emitAll();
      expect(insights).toHaveLength(1);
    });

    it("getInsights() accumulates emitted insights across calls", async () => {
      const store = makeStore();
      await store.recordSignal(makeFailedSignal({ proposalId: "prop-a" }));
      const emitter = new RollbackInsightEmitter({ store });
      await emitter.emitAll();

      await store.recordSignal(makeFailedSignal({ proposalId: "prop-b" }));
      await emitter.emitAll();

      const all = emitter.getInsights();
      expect(all).toHaveLength(2);
      expect(all.map((i) => i.id).sort()).toEqual([
        "rollback-insight:prop-a",
        "rollback-insight:prop-b",
      ]);
    });
  });

  // ── emitAll — multiple proposals ───────────────────────────────────────────

  describe("emitAll — multiple proposals", () => {
    it("emits one rollback Insight per distinct failed proposal", async () => {
      const store = makeStore();
      await store.recordSignal(makeFailedSignal({ proposalId: "prop-a", capability: "cap-a" }));
      await store.recordSignal(makeFailedSignal({ proposalId: "prop-b", capability: "cap-b" }));
      const emitter = new RollbackInsightEmitter({ store });

      const insights = await emitter.emitAll();
      expect(insights).toHaveLength(2);
      expect(insights.map((i) => i.entity).sort()).toEqual(["cap-a", "cap-b"]);
    });
  });

  // ── emitAll — since filter ─────────────────────────────────────────────────

  describe("emitAll — since filter", () => {
    it("only processes failed signals recorded at or after the since date", async () => {
      const store = makeStore();
      await store.recordSignal(
        makeFailedSignal({ proposalId: "prop-old" }, new Date("2026-01-01T00:00:00Z")),
      );
      await store.recordSignal(
        makeFailedSignal({ proposalId: "prop-new" }, new Date("2026-02-01T00:00:00Z")),
      );
      const emitter = new RollbackInsightEmitter({ store });

      const insights = await emitter.emitAll({ since: new Date("2026-01-20T00:00:00Z") });
      expect(insights).toHaveLength(1);
      expect(first(insights).id).toBe("rollback-insight:prop-new");
    });
  });
});
