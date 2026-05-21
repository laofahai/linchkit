/**
 * ProposalEffectVerifier — Spec 55 §7.7 "Feedback loop: Phase 2".
 *
 * After a Proposal is merged, verifies whether its stated `successMetric`
 * was actually achieved by comparing the current baseline value in MemoryStore
 * against the original baseline and target recorded in the Proposal.
 *
 * Design constraints (mirrors Phase 1 ProposalOutcomeRecorder):
 *   - Small, focused engine — no scheduling, no polling.
 *   - Caller-composed — the caller decides when to call `verify()` (e.g. on
 *     a scheduled job or triggered via a deploy webhook callback).
 *   - Pure result — does NOT write to MemoryStore itself. Returns a
 *     `EffectVerificationResult` that the caller handles (store, surface, etc.).
 *
 * signalRef convention:
 *   `ProposalSuccessMetric.signalRef` must follow the `"entity.metric"` format
 *   (e.g. `"supplier_contact.manual_edit_rate"`) so the verifier can look up
 *   the current baseline via `MemoryStore.getBaseline(entity, metric)`.
 *   If the format is not followed, the result is `effect_uncertain`.
 */

import type { Baseline, Insight, MemoryStore } from "../types/life-system";
import type { ProposalOutcomePayload } from "./proposal-outcome-recorder";

// ── Verification outcome status ───────────────────────────

/**
 * Three-way outcome of effect verification (Spec 55 §7.7):
 * - `effect_verified`  — current value has met or exceeded the target
 * - `effect_uncertain` — insufficient data to conclude (baseline unavailable,
 *                        signalRef not parseable, or value improving but not yet at target)
 * - `effect_failed`    — current value regressed from the pre-Proposal baseline
 */
export type EffectVerificationStatus = "effect_verified" | "effect_uncertain" | "effect_failed";

// ── Result ────────────────────────────────────────────────

export interface EffectVerificationResult {
  status: EffectVerificationStatus;
  proposalId: string;
  /** Human-readable explanation of the verdict. */
  message: string;
  /** Current numeric value retrieved from MemoryStore. Undefined when baseline is unavailable. */
  currentValue?: number;
  /**
   * Present only when `status === "effect_failed"`.
   * Tagged with `["rollback_candidate"]` — the caller decides whether to
   * store, surface, or escalate it.
   */
  rollbackInsight?: Insight;
}

// ── Options ───────────────────────────────────────────────

export interface ProposalEffectVerifierOptions {
  /** Memory store used to look up current baselines. */
  store: MemoryStore;
}

// ── ProposalEffectVerifier ────────────────────────────────

export class ProposalEffectVerifier {
  private readonly store: MemoryStore;

  constructor(opts: ProposalEffectVerifierOptions) {
    this.store = opts.store;
  }

  /**
   * Verify whether the effect of a merged Proposal was achieved.
   *
   * Looks up the current baseline for the `successMetric.signalRef` and
   * compares it against the pre-Proposal `baseline` and `target` values.
   *
   * Returns `effect_uncertain` when data is insufficient — it does NOT throw.
   */
  async verify(outcomePayload: ProposalOutcomePayload): Promise<EffectVerificationResult> {
    const { proposalId, successMetric } = outcomePayload;

    if (
      !successMetric?.signalRef ||
      successMetric.baseline === undefined ||
      successMetric.target === undefined
    ) {
      return {
        status: "effect_uncertain",
        proposalId,
        message:
          "successMetric missing or incomplete (need signalRef, baseline, and target) — skipping verification.",
      };
    }

    const { signalRef, baseline: baselineValue, target } = successMetric;

    const dotIdx = signalRef.indexOf(".");
    if (dotIdx <= 0 || dotIdx === signalRef.length - 1) {
      return {
        status: "effect_uncertain",
        proposalId,
        message: `signalRef "${signalRef}" does not follow "entity.metric" convention — skipping verification.`,
      };
    }

    const entity = signalRef.slice(0, dotIdx);
    const metric = signalRef.slice(dotIdx + 1);

    const currentBaseline = await this.store.getBaseline(entity, metric);
    if (!currentBaseline) {
      return {
        status: "effect_uncertain",
        proposalId,
        message: `No baseline found for "${signalRef}" — cannot verify effect yet.`,
      };
    }

    const currentValue = currentBaseline.value;

    if (target === baselineValue) {
      return {
        status: "effect_uncertain",
        proposalId,
        message: "target equals baseline — improvement direction is undefined.",
        currentValue,
      };
    }

    const wantIncrease = target > baselineValue;

    if (wantIncrease) {
      if (currentValue >= target) {
        return {
          status: "effect_verified",
          proposalId,
          message: `Target reached: current ${currentValue} ≥ target ${target}.`,
          currentValue,
        };
      }
      if (currentValue < baselineValue) {
        return {
          status: "effect_failed",
          proposalId,
          message: `Value regressed: baseline was ${baselineValue}, now ${currentValue} (target ${target}).`,
          currentValue,
          rollbackInsight: this.buildRollbackInsight(outcomePayload, currentBaseline, currentValue),
        };
      }
      return {
        status: "effect_uncertain",
        proposalId,
        message: `Improving toward target (current ${currentValue}, target ${target}) — not yet verified.`,
        currentValue,
      };
    }

    // wantDecrease
    if (currentValue <= target) {
      return {
        status: "effect_verified",
        proposalId,
        message: `Target reached: current ${currentValue} ≤ target ${target}.`,
        currentValue,
      };
    }
    if (currentValue > baselineValue) {
      return {
        status: "effect_failed",
        proposalId,
        message: `Value regressed: baseline was ${baselineValue}, now ${currentValue} (target ${target}).`,
        currentValue,
        rollbackInsight: this.buildRollbackInsight(outcomePayload, currentBaseline, currentValue),
      };
    }
    return {
      status: "effect_uncertain",
      proposalId,
      message: `Improving toward target (current ${currentValue}, target ${target}) — not yet verified.`,
      currentValue,
    };
  }

  private buildRollbackInsight(
    outcomePayload: ProposalOutcomePayload,
    currentBaseline: Baseline,
    currentValue: number,
  ): Insight {
    const now = new Date();
    const id = `rollback-${outcomePayload.proposalId}-${now.getTime()}-${Math.random().toString(36).slice(2)}`;
    return {
      id,
      type: "anomaly",
      confidence: 0.9,
      impact: "high",
      evidence: {
        signals: [],
        baseline: currentBaseline,
        context: {
          proposalId: outcomePayload.proposalId,
          capability: outcomePayload.capability,
          currentValue,
          successMetric: outcomePayload.successMetric,
        },
      },
      summary: `Proposal "${outcomePayload.proposalTitle}" effect failed: ${currentBaseline.entity}.${currentBaseline.metric} regressed to ${currentValue} (baseline ${outcomePayload.successMetric?.baseline}, target ${outcomePayload.successMetric?.target}).`,
      causality: "causal",
      entity: currentBaseline.entity,
      createdAt: now,
      tags: ["rollback_candidate"],
    };
  }
}

// ── Factory ───────────────────────────────────────────────

/** Create a new ProposalEffectVerifier instance. */
export function createProposalEffectVerifier(
  opts: ProposalEffectVerifierOptions,
): ProposalEffectVerifier {
  return new ProposalEffectVerifier(opts);
}
