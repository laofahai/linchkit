/**
 * RollbackInsightEmitter — Spec 55 §7.7 Phase 2 "Feedback loop" (downstream).
 *
 * Closes the loop opened by {@link ProposalEffectVerifier}: when a merged
 * Proposal fails to achieve its declared successMetric, the verifier emits a
 * `proposal:effect:failed` signal carrying `rollback_candidate: true`. This
 * engine reads those signals and surfaces ONE rollback `Insight` per failed
 * proposal, tagged `"rollback_candidate"`, so the approval queue can review a
 * potential rollback.
 *
 * The emitted Insight is an evidence-backed observation — NOT an executed
 * action. Per Spec 55 + the "AI Never Modifies Production Directly" principle,
 * a rollback only ever happens through a separate human-approved Proposal. This
 * engine therefore does NOT auto-execute a rollback, does NOT invoke
 * DeployRollbackOrchestrator, and does NOT create a Proposal — it merely makes
 * the failure visible as a governed Insight.
 *
 * Idempotent: the deterministic Insight id `rollback-insight:<proposalId>`
 * guarantees a failed proposal is surfaced at most once across repeated calls.
 *
 * Intentionally NOT auto-wired. Pattern mirrors ProposalEffectVerifier.
 *
 *   const emitter = createRollbackInsightEmitter({ store });
 *   const insights = await emitter.emitAll();
 */

import type { Insight, SensorSignal } from "../types/life-system";
import type { Logger } from "../types/logger";
import type { EffectVerificationPayload, VerifiableSignalStore } from "./proposal-effect-verifier";

// ── Constants ──────────────────────────────────────────────────────────────

/** Signal type read from the store — emitted by ProposalEffectVerifier on failure. */
const EFFECT_FAILED_SIGNAL_TYPE = "proposal:effect:failed";

/** Semantic tag stamped on every rollback Insight for downstream routing. */
export const ROLLBACK_CANDIDATE_TAG = "rollback_candidate";

/**
 * Confidence assigned to a rollback Insight. The upstream verifier already
 * established (deterministically) that the post-merge metric regressed at or
 * below baseline, so the fact is high-confidence — but we leave headroom below
 * 1.0 because the metric may yet be noisy or attributable to other changes.
 */
const ROLLBACK_INSIGHT_CONFIDENCE = 0.9;

// ── Options ────────────────────────────────────────────────────────────────

export interface RollbackInsightEmitterOptions {
  store: VerifiableSignalStore;
  logger?: Logger;
}

export interface EmitAllOptions {
  /** Only examine effect_failed signals recorded at or after this date. */
  since?: Date;
}

// ── Engine ─────────────────────────────────────────────────────────────────

export class RollbackInsightEmitter {
  private readonly store: VerifiableSignalStore;
  private readonly logger?: Logger;
  /** Promoted rollback insights, keyed by deterministic id for dedup. */
  private readonly emitted = new Map<string, Insight>();

  constructor(opts: RollbackInsightEmitterOptions) {
    this.store = opts.store;
    this.logger = opts.logger;
  }

  /**
   * Read every `proposal:effect:failed` signal and surface a rollback Insight
   * for each one that carries `rollback_candidate === true`.
   *
   * Idempotent: a proposalId already surfaced in a previous call (or earlier in
   * this call, for duplicate signals) is skipped. Returns ONLY the insights
   * newly produced by this call (mirrors `InsightEngine.generateInsights`).
   */
  async emitAll(opts?: EmitAllOptions): Promise<Insight[]> {
    const failedSignals = await this.store.getSignals({
      type: EFFECT_FAILED_SIGNAL_TYPE,
      since: opts?.since,
    });

    const newInsights: Insight[] = [];

    for (const signal of failedSignals) {
      const payload = signal.payload as EffectVerificationPayload | null;
      // Guard: need a populated payload that is genuinely a rollback candidate.
      if (payload?.rollback_candidate !== true || !payload.proposalId) {
        continue;
      }

      const id = rollbackInsightId(payload.proposalId);
      // Idempotency: dedup by deterministic id across and within calls.
      if (this.emitted.has(id)) {
        continue;
      }

      // The originating Signal always carries a valid `timestamp: Date`; thread
      // it through as a deterministic fallback for a missing/invalid verifiedAt.
      const insight = buildRollbackInsight(id, payload, signal.timestamp);
      this.emitted.set(id, insight);
      newInsights.push(insight);

      this.logger?.info?.(
        `RollbackInsightEmitter: surfaced rollback Insight for proposal "${payload.proposalId}"`,
        {
          proposalId: payload.proposalId,
          capability: payload.capability,
          signalRef: payload.signalRef,
        },
      );
    }

    return newInsights;
  }

  /**
   * All rollback insights surfaced so far, across every `emitAll` call.
   * Mirrors `InsightEngine.getInsights()` so the same downstream pipeline can
   * consume rollback insights alongside ordinary ones.
   */
  getInsights(): Insight[] {
    return [...this.emitted.values()];
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Deterministic Insight id derived from the failed proposal's id. */
export function rollbackInsightId(proposalId: string): string {
  return `rollback-insight:${proposalId}`;
}

/**
 * Shape the `proposal:effect:failed` payload into a single rollback Insight.
 *
 * - `type: "anomaly"` — a merged change that regressed its metric is an
 *   anomalous outcome (Spec 55 §6.2), not a friction/pattern/structural one.
 * - `causality: "causal"` — the verifier measured the metric after the merge,
 *   attributing the failure to the merged change.
 * - `impact: "high"` — a shipped-then-failed change is a high-priority signal.
 *
 * `fallbackTimestamp` is the originating Signal's `timestamp` (always a valid
 * `Date`), used for `createdAt` / evidence timestamp when `verifiedAt` is
 * missing or unparseable — keeping the result deterministic (no `Date.now()`).
 */
function buildRollbackInsight(
  id: string,
  payload: EffectVerificationPayload,
  fallbackTimestamp: Date,
): Insight {
  const {
    proposalId,
    capability,
    signalRef,
    baselineValue,
    targetValue,
    currentValue,
    verifiedAt,
    mergedSha,
  } = payload;

  // Robust date: fall back to the originating Signal's timestamp when verifiedAt
  // is absent or yields an Invalid Date — never produce an unserializable date.
  const parsed = verifiedAt === undefined ? Number.NaN : new Date(verifiedAt).getTime();
  const verifiedDate = Number.isNaN(parsed) ? fallbackTimestamp : new Date(parsed);

  // SensorSignal.value is a required `number`, so a missing measurement cannot
  // be represented as `undefined`. We fall back to the baseline for `value` but
  // record `hasMeasurement: false` in context so downstream consumers can tell a
  // baseline fallback apart from a genuine reading (avoids masking a "no
  // measurement" state as a real baseline reading).
  const hasMeasurement = currentValue !== undefined;
  const evidenceSignal: SensorSignal = {
    sensor: "proposal-effect-verifier",
    source: "event_bus",
    timestamp: verifiedDate,
    value: currentValue ?? baselineValue,
    baseline: baselineValue,
    deviation: 0,
    confidence: ROLLBACK_INSIGHT_CONFIDENCE,
    context: { proposalId, capability, signalRef, result: payload.result, hasMeasurement },
  };

  const currentText = currentValue === undefined ? "no measurement" : String(currentValue);
  const summary =
    `Merged proposal "${proposalId}" on capability "${capability}" failed its successMetric: ` +
    `${signalRef} did not improve from baseline ${baselineValue} toward target ${targetValue} ` +
    `(current: ${currentText}). Rollback candidate — review for a rollback Proposal.`;

  return {
    id,
    type: "anomaly",
    confidence: ROLLBACK_INSIGHT_CONFIDENCE,
    impact: "high",
    evidence: {
      signals: [evidenceSignal],
      context: {
        proposalId,
        capability,
        signalRef,
        baselineValue,
        targetValue,
        currentValue,
        // Carry the merged commit SHA so the rollback translator can stamp it on
        // the revert change (Spec 55 §7.7). Undefined when the upstream verifier
        // had no SHA (out-of-band merge / pre-SHA-capture proposal).
        mergedSha,
      },
    },
    summary,
    causality: "causal",
    // The proposal targeted this capability; signalRef's entity is the same root.
    entity: capability,
    createdAt: verifiedDate,
    tags: [ROLLBACK_CANDIDATE_TAG],
  };
}

// ── Factory ────────────────────────────────────────────────────────────────

export function createRollbackInsightEmitter(
  opts: RollbackInsightEmitterOptions,
): RollbackInsightEmitter {
  return new RollbackInsightEmitter(opts);
}
