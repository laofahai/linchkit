/**
 * ProposalEffectVerifier — Spec 55 §7.7 Phase 2 "Effect Verification".
 *
 * After a Proposal merges, verifies whether the declared successMetric was met.
 * Reads Phase 1 outcome signals (proposal:outcome:merged) from MemoryStore and
 * compares the post-merge baseline.value for the signalRef against the original
 * targetValue.
 *
 * Emits one verification signal per merged+verifiable proposal:
 *   proposal:effect:verified  — progress >= verifyThreshold towards targetValue
 *   proposal:effect:uncertain — no current baseline found for signalRef, or partial progress
 *   proposal:effect:failed    — current baseline.value <= baselineValue (no improvement)
 *
 * On effect_failed the payload includes rollback_candidate: true so downstream
 * InsightEngines can surface a rollback Insight to the approval queue.
 *
 * Intentionally NOT auto-wired. Pattern mirrors ProposalOutcomeRecorder (Phase 1).
 *
 *   const verifier = createProposalEffectVerifier({ store });
 *   const results = await verifier.verifyAll();
 */

import type { MemoryStore, Signal } from "../types/life-system";
import type { Logger } from "../types/logger";
import type { ProposalOutcomePayload } from "./proposal-outcome-recorder";

// ── Extended store interface ─────────────────────────────────────────────────

/**
 * Extension of MemoryStore that supports signal queries.
 * InMemoryMemoryStore satisfies this interface out of the box.
 */
export interface VerifiableSignalStore extends MemoryStore {
  getSignals(opts?: {
    /** Filter by signal type (exact match on Signal.type). */
    type?: string;
    entity?: string;
    since?: Date;
    limit?: number;
  }): Promise<Signal[]>;
}

// ── Result types ─────────────────────────────────────────────────────────────

/** Three possible outcomes of a post-merge effect check (Spec 55 §7.7). */
export type EffectVerificationResult = "effect_verified" | "effect_uncertain" | "effect_failed";

/** One verification record per merged proposal that carried a successMetric.signalRef. */
export interface EffectVerificationRecord {
  proposalId: string;
  capability: string;
  /** Original signalRef from successMetric — format: "entity", "entity:metric", or "entity.metric". */
  signalRef: string;
  baselineValue: number;
  targetValue: number;
  /** Current baseline.value for signalRef; undefined when no baseline found. */
  currentValue: number | undefined;
  result: EffectVerificationResult;
  verifiedAt: string;
}

/** Payload written to MemoryStore for each verification signal. */
export interface EffectVerificationPayload extends EffectVerificationRecord {
  /** True when result is effect_failed — marks rollback eligibility for consumers. */
  rollback_candidate: boolean;
}

// ── Options ───────────────────────────────────────────────────────────────────

export interface ProposalEffectVerifierOptions {
  store: VerifiableSignalStore;
  logger?: Logger;
  /**
   * Fractional progress towards (targetValue - baselineValue) required before
   * classifying as "effect_verified". Default: 0.9 (90% of the gap closed).
   */
  verifyThreshold?: number;
}

export interface VerifyAllOptions {
  /** Only examine merged outcome signals recorded at or after this date. */
  since?: Date;
}

// ── Engine ────────────────────────────────────────────────────────────────────

export class ProposalEffectVerifier {
  private readonly store: VerifiableSignalStore;
  private readonly logger?: Logger;
  private readonly verifyThreshold: number;

  constructor(opts: ProposalEffectVerifierOptions) {
    this.store = opts.store;
    this.logger = opts.logger;
    this.verifyThreshold = opts.verifyThreshold ?? 0.9;
  }

  /**
   * Verify all merged proposals whose outcome signal carries a successMetric.
   * Skips outcome records without a signalRef (nothing to compare against).
   * Returns one EffectVerificationRecord per verifiable merged outcome.
   */
  async verifyAll(opts?: VerifyAllOptions): Promise<EffectVerificationRecord[]> {
    const mergedSignals = await this.store.getSignals({
      type: "proposal:outcome:merged",
      since: opts?.since,
    });

    const results: EffectVerificationRecord[] = [];

    for (const signal of mergedSignals) {
      const payload = signal.payload as ProposalOutcomePayload | null;
      const successMetric = payload?.successMetric;
      const signalRef = successMetric?.signalRef;
      // Need a signalRef plus numeric baseline/target to compute progress.
      if (
        !payload ||
        !successMetric ||
        !signalRef ||
        successMetric.baselineValue === undefined ||
        successMetric.targetValue === undefined
      ) {
        continue;
      }
      results.push(
        await this.verifySingle(payload, signalRef, {
          baselineValue: successMetric.baselineValue,
          targetValue: successMetric.targetValue,
        }),
      );
    }

    return results;
  }

  private async verifySingle(
    payload: ProposalOutcomePayload,
    signalRef: string,
    successMetric: { baselineValue: number; targetValue: number },
  ): Promise<EffectVerificationRecord> {
    const { baselineValue, targetValue } = successMetric;

    // Parse "entity:metric", "entity.metric", or bare "entity" (metric defaults to "value").
    // Use the first occurrence of ':' or '.', whichever appears first.
    const colonIdx = signalRef.indexOf(":");
    const dotIdx = signalRef.indexOf(".");
    const sepIdx = (() => {
      if (colonIdx < 0 && dotIdx < 0) return -1;
      if (colonIdx < 0) return dotIdx;
      if (dotIdx < 0) return colonIdx;
      return Math.min(colonIdx, dotIdx);
    })();
    const entity = sepIdx >= 0 ? signalRef.slice(0, sepIdx) : signalRef;
    const metric = sepIdx >= 0 ? signalRef.slice(sepIdx + 1) : "value";

    const baseline = await this.store.getBaseline(entity, metric);
    const verifiedAt = new Date().toISOString();

    let result: EffectVerificationResult;
    let currentValue: number | undefined;

    if (baseline === null) {
      result = "effect_uncertain";
      currentValue = undefined;
    } else {
      currentValue = baseline.value;
      const gap = targetValue - baselineValue;
      const requiredValue = baselineValue + this.verifyThreshold * gap;

      if (gap > 0) {
        // Increasing goal: current must reach requiredValue (above baseline)
        if (currentValue >= requiredValue) result = "effect_verified";
        else if (currentValue <= baselineValue) result = "effect_failed";
        else result = "effect_uncertain";
      } else if (gap < 0) {
        // Decreasing goal: current must drop to requiredValue (below baseline)
        if (currentValue <= requiredValue) result = "effect_verified";
        else if (currentValue >= baselineValue) result = "effect_failed";
        else result = "effect_uncertain";
      } else {
        // target === baseline — no measurable gap; cannot determine effect
        result = "effect_uncertain";
      }
    }

    const record: EffectVerificationRecord = {
      proposalId: payload.proposalId,
      capability: payload.capability,
      signalRef,
      baselineValue,
      targetValue,
      currentValue,
      result,
      verifiedAt,
    };

    await this.emitVerificationSignal(record);

    this.logger?.info?.(
      `ProposalEffectVerifier: "${result}" for proposal "${payload.proposalId}"`,
      { proposalId: payload.proposalId, result, signalRef, currentValue, targetValue },
    );

    return record;
  }

  private async emitVerificationSignal(record: EffectVerificationRecord): Promise<void> {
    const signalTypeSuffix = record.result.replace("effect_", "");
    const verificationPayload: EffectVerificationPayload = {
      ...record,
      rollback_candidate: record.result === "effect_failed",
    };

    await this.store.recordSignal({
      type: `proposal:effect:${signalTypeSuffix}`,
      source: "event_bus",
      timestamp: new Date(),
      payload: verificationPayload,
    });
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createProposalEffectVerifier(
  opts: ProposalEffectVerifierOptions,
): ProposalEffectVerifier {
  return new ProposalEffectVerifier(opts);
}
