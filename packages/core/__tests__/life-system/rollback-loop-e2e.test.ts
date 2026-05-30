/**
 * End-to-end integration test for the Spec 55 §7.7 evolution / rollback loop.
 *
 * Wires the REAL life-system components against ONE shared InMemoryMemoryStore,
 * proving the full chain a regressed merged Proposal travels:
 *
 *   ProposalOutcomeRecorder.recordOutcome("merged", { mergedSha })   // Phase 1
 *     → proposal:outcome:merged signal (carries mergedSha + successMetric)
 *   ProposalEffectVerifier.verifyAll()                                // Phase 2
 *     → reads the merged outcome, measures the post-merge baseline,
 *       classifies effect_failed, emits proposal:effect:failed (rollback_candidate)
 *   RollbackInsightEmitter.emitAll()                                  // Phase 2 (downstream)
 *     → surfaces a rollback Insight tagged "rollback_candidate"
 *   rollbackCandidateTranslator                                       // Spec 55 §7 bridge
 *     → translates the Insight into a GOVERNANCE-SAFE draft revert Proposal
 *   rollbackInputFromProposal                                         // Spec 55 §7.7 consumption point
 *     → declines a draft, accepts only an approved revert Proposal
 *
 * Two invariants are the heart of this test:
 *
 * 1. SHA threading — the merged commit SHA must survive EVERY hop unchanged so a
 *    rollback can `git revert` the EXACT commit.
 * 2. The recorder↔verifier SEAM — the verifier must actually FIND the recorder's
 *    signal. This is the regression guard for the fixed dot/colon signal-type
 *    mismatch: before the fix the recorder wrote `proposal.outcome.merged` while
 *    the verifier queried `proposal:outcome:merged`, so verifyAll() returned []
 *    and the whole loop was silently dead.
 *
 * Determinism: a frozen clock + fixed id generator are injected into the
 * translator. No assertion relies on real timers or Date.now().
 */

import { describe, expect, test } from "bun:test";
import { rollbackInputFromProposal } from "../../src/deployment/rollback-orchestrator";
import {
  createProposalEffectVerifier,
  type EffectVerificationPayload,
} from "../../src/engine/proposal-effect-verifier";
import {
  createProposalOutcomeRecorder,
  type ProposalOutcomePayload,
} from "../../src/engine/proposal-outcome-recorder";
import {
  createRollbackInsightEmitter,
  ROLLBACK_CANDIDATE_TAG,
} from "../../src/engine/rollback-insight-emitter";
import { InMemoryMemoryStore } from "../../src/life-system/in-memory-memory-store";
import { rollbackCandidateTranslator } from "../../src/life-system/insight-to-proposal";
import type { Baseline } from "../../src/types/life-system";
import type { ProposalDefinition, SuccessMetric } from "../../src/types/proposal";

// ── Deterministic fixtures ──────────────────────────────────────────────────

/** Merged commit SHA threaded end-to-end. 12 hex chars — a valid short SHA. */
const MERGED_SHA = "a1b2c3d4e5f6";

/** Frozen clock + fixed id generator for the translator (no Date.now reliance). */
const FROZEN_NOW = new Date("2026-05-30T00:00:00.000Z");
const TRANSLATOR_CTX = {
  now: () => FROZEN_NOW,
  idGenerator: () => "proposal_rollback_e2e",
} as const;

/**
 * Increasing-goal successMetric that REGRESSES after merge: baseline 50, target
 * 80, but the post-merge measurement drops to 45 (≤ baseline) → effect_failed.
 * signalRef "cap-orders:fill_rate" parses to entity "cap-orders" / metric
 * "fill_rate" for the verifier's baseline lookup.
 */
const SIGNAL_REF = "cap-orders:fill_rate";
const METRIC_ENTITY = "cap-orders";
const METRIC_NAME = "fill_rate";
const BASELINE_VALUE = 50;
const TARGET_VALUE = 80;
/** Post-merge value at/below baseline → unambiguous effect_failed. */
const REGRESSED_VALUE = 45;

const SUCCESS_METRIC: SuccessMetric = {
  description: "Order fill rate should climb from 50% to 80% after the change.",
  signalRef: SIGNAL_REF,
  insightRef: "insight-orders-1",
  baselineValue: BASELINE_VALUE,
  targetValue: TARGET_VALUE,
  unit: "%",
};

const PROPOSAL_ID = "proposal-orders-merged-001";

function makeMergedProposal(overrides: Partial<ProposalDefinition> = {}): ProposalDefinition {
  return {
    id: PROPOSAL_ID,
    title: "Auto-batch order fulfilment",
    description: "Generated from insight insight-orders-1.",
    author: { type: "ai", id: "insight-translator", name: "Insight Translator" },
    capability: "cap-orders",
    changeType: "minor",
    changes: [],
    impact: {
      schemasAffected: [],
      actionsAffected: [],
      rulesAffected: [],
      dependentsAffected: [],
      migrationRequired: false,
    },
    status: "committed",
    successMetric: SUCCESS_METRIC,
    createdAt: FROZEN_NOW,
    updatedAt: FROZEN_NOW,
    ...overrides,
  };
}

/** Baseline that makes the post-merge measurement a regression (effect_failed). */
function regressedBaseline(): Baseline {
  return {
    entity: METRIC_ENTITY,
    metric: METRIC_NAME,
    value: REGRESSED_VALUE,
    calculatedAt: FROZEN_NOW,
  };
}

// ── The loop ─────────────────────────────────────────────────────────────────

describe("Spec 55 §7.7 rollback loop — e2e (real components, shared store)", () => {
  test("merged regression with a SHA flows to an approved, SHA-carrying rollback input", async () => {
    // ── ONE shared store wires all four real components together. ──────────────
    const store = new InMemoryMemoryStore();
    // The post-merge measurement that regresses the metric below baseline.
    await store.updateBaseline(regressedBaseline());

    // ── Phase 1: record the merged outcome WITH the merged commit SHA. ────────
    const recorder = createProposalOutcomeRecorder({ store });
    await recorder.recordOutcome(makeMergedProposal(), "merged", { mergedSha: MERGED_SHA });

    // Hop 1 — the outcome signal payload carries the SHA. This also pins the
    // canonical colon-delimited signal type the verifier queries.
    const outcomeSignals = await store.getSignals({ type: "proposal:outcome:merged" });
    expect(outcomeSignals).toHaveLength(1);
    const outcomePayload = outcomeSignals[0]?.payload as ProposalOutcomePayload;
    expect(outcomePayload.mergedSha).toBe(MERGED_SHA);

    // ── Phase 2: verify effects. ──────────────────────────────────────────────
    const verifier = createProposalEffectVerifier({ store });
    const verificationRecords = await verifier.verifyAll();

    // REGRESSION GUARD for the fixed seam: before the recorder emitted colons,
    // verifyAll() returned [] because its `proposal:outcome:merged` query never
    // matched the recorder's `proposal.outcome.merged` signal. A non-empty result
    // here PROVES the recorder→verifier seam is reconnected.
    expect(verificationRecords).toHaveLength(1);
    const record = verificationRecords[0];
    if (!record) throw new Error("expected one verification record");
    expect(record.proposalId).toBe(PROPOSAL_ID);
    expect(record.result).toBe("effect_failed");
    expect(record.currentValue).toBe(REGRESSED_VALUE);
    // Hop 2 — the SHA survives onto the EffectVerificationRecord.
    expect(record.mergedSha).toBe(MERGED_SHA);

    // Hop 2 (signal) — and onto the emitted proposal:effect:failed signal.
    const failedSignals = await store.getSignals({ type: "proposal:effect:failed" });
    expect(failedSignals).toHaveLength(1);
    const failedPayload = failedSignals[0]?.payload as EffectVerificationPayload;
    expect(failedPayload.rollback_candidate).toBe(true);
    expect(failedPayload.mergedSha).toBe(MERGED_SHA);

    // ── Phase 2 (downstream): surface the rollback Insight. ───────────────────
    const emitter = createRollbackInsightEmitter({ store });
    const insights = await emitter.emitAll();

    expect(insights).toHaveLength(1);
    const insight = insights[0];
    if (!insight) throw new Error("expected one rollback insight");
    expect(insight.type).toBe("anomaly");
    expect(insight.tags).toContain(ROLLBACK_CANDIDATE_TAG);
    expect(insight.entity).toBe("cap-orders");
    // Hop 3 — the SHA reaches the rollback Insight's evidence context.
    expect((insight.evidence.context as { mergedSha?: string }).mergedSha).toBe(MERGED_SHA);

    // ── Spec 55 §7 bridge: translate the Insight to a draft revert Proposal. ──
    const draft = await rollbackCandidateTranslator(insight, TRANSLATOR_CTX);
    if (!draft) throw new Error("expected the rollback translator to produce a proposal");

    // GOVERNANCE: a translated rollback is ALWAYS a draft — never auto-approved.
    expect(draft.status).toBe("draft");
    expect(draft.changeType).toBe("major");
    const revertChange = draft.changes.find((c) => c.target === "revert");
    if (!revertChange) throw new Error("expected a revert change");
    expect(revertChange.name).toBe("revert");
    // Hop 4 — the SHA lands on the typed revertSha of the revert change.
    expect(revertChange.revertSha).toBe(MERGED_SHA);
    // The proposal being reverted is carried out-of-band for the executor.
    expect(revertChange.diff).toContain(PROPOSAL_ID);
    expect(revertChange.diff).toContain(MERGED_SHA);

    // ── Spec 55 §7.7 consumption point: the governance gate. ──────────────────
    // A draft must NEVER feed a rollback execution.
    expect(rollbackInputFromProposal(draft)).toBeNull();

    // Only after a HUMAN flips it to "approved" does the executor input resolve —
    // carrying the EXACT SHA that travelled the whole loop unchanged.
    const approved: ProposalDefinition = { ...draft, status: "approved" };
    const rollbackInput = rollbackInputFromProposal(approved);
    expect(rollbackInput).not.toBeNull();
    expect(rollbackInput?.commitSha).toBe(MERGED_SHA);

    // Final cross-hop equality: the SHA is identical at every hop it traversed.
    expect(
      new Set([
        outcomePayload.mergedSha,
        record.mergedSha,
        failedPayload.mergedSha,
        (insight.evidence.context as { mergedSha?: string }).mergedSha,
        revertChange.revertSha,
        rollbackInput?.commitSha,
      ]),
    ).toEqual(new Set([MERGED_SHA]));
  });

  test("inverse successMetric restores the pre-merge baseline as its target", async () => {
    // A focused check that the translated rollback's metric is the INVERSE of the
    // failed proposal's: it should drive the regressed value back toward baseline.
    const store = new InMemoryMemoryStore();
    await store.updateBaseline(regressedBaseline());

    const recorder = createProposalOutcomeRecorder({ store });
    await recorder.recordOutcome(makeMergedProposal(), "merged", { mergedSha: MERGED_SHA });
    await createProposalEffectVerifier({ store }).verifyAll();
    const insight = (await createRollbackInsightEmitter({ store }).emitAll())[0];
    if (!insight) throw new Error("expected one rollback insight");

    const draft = await rollbackCandidateTranslator(insight, TRANSLATOR_CTX);
    if (!draft) throw new Error("expected a rollback proposal");

    // Inverse: new baseline = regressed currentValue, new target = pre-merge baseline.
    expect(draft.successMetric?.signalRef).toBe(SIGNAL_REF);
    expect(draft.successMetric?.insightRef).toBe(insight.id);
    expect(draft.successMetric?.baselineValue).toBe(REGRESSED_VALUE);
    expect(draft.successMetric?.targetValue).toBe(BASELINE_VALUE);
  });

  test("negative path: a merged outcome with NO SHA yields a draft revert WITHOUT revertSha", async () => {
    // Same regression, but the merge happened out-of-band / pre-SHA-capture, so no
    // mergedSha enters the loop. The loop still produces a governed draft revert
    // Proposal — it just cannot carry a revertSha, so an approved version still
    // declines at the consumption point (a human must supply the SHA first).
    const store = new InMemoryMemoryStore();
    await store.updateBaseline(regressedBaseline());

    const recorder = createProposalOutcomeRecorder({ store });
    // No { mergedSha } passed — the merged outcome carries no SHA.
    await recorder.recordOutcome(makeMergedProposal(), "merged");

    const outcomePayload = (await store.getSignals({ type: "proposal:outcome:merged" }))[0]
      ?.payload as ProposalOutcomePayload;
    expect(outcomePayload.mergedSha).toBeUndefined();

    const record = (await createProposalEffectVerifier({ store }).verifyAll())[0];
    if (!record) throw new Error("expected one verification record");
    expect(record.result).toBe("effect_failed");
    expect(record.mergedSha).toBeUndefined();

    const insight = (await createRollbackInsightEmitter({ store }).emitAll())[0];
    if (!insight) throw new Error("expected one rollback insight");
    expect((insight.evidence.context as { mergedSha?: string }).mergedSha).toBeUndefined();

    const draft = await rollbackCandidateTranslator(insight, TRANSLATOR_CTX);
    if (!draft) throw new Error("expected a rollback proposal");

    // A valid draft revert Proposal is still produced — just without a SHA.
    expect(draft.status).toBe("draft");
    const revertChange = draft.changes.find((c) => c.target === "revert");
    if (!revertChange) throw new Error("expected a revert change");
    expect(revertChange.revertSha).toBeUndefined();
    expect("revertSha" in revertChange).toBe(false);

    // Governance gate: even an APPROVED no-SHA revert declines — there is no
    // commit to revert until a human supplies one.
    const approvedNoSha: ProposalDefinition = { ...draft, status: "approved" };
    expect(rollbackInputFromProposal(approvedNoSha)).toBeNull();
  });
});
