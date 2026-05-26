/**
 * ProposalEffectVerifier — Spec 55 §7.7 Phase 2 "Feedback loop: effect verification".
 *
 * After a Proposal merges, the caller can periodically call `verify()` with
 * the recorded outcome payloads (produced by Phase 1 ProposalOutcomeRecorder).
 * For each merged Proposal whose `successMetric` is set, this engine fetches
 * the current metric value and compares it to the target.
 *
 * Verdicts:
 *   - `effect_verified`  — currentValue ≥ targetValue (goal achieved)
 *   - `effect_uncertain` — no data available yet (signalRef missing or unresolvable)
 *   - `effect_failed`    — currentValue < targetValue (goal not met)
 *
 * On `effect_failed` the engine additionally writes a `proposal:effect:rollback_candidate`
 * signal so the Insight layer can surface a human-reviewed rollback Proposal.
 * Rollback itself requires a separate, human-approved Proposal (same governance gate).
 *
 * Intentionally NOT auto-wired into ProposalEngine. Callers compose it and decide
 * when to run verification (e.g. a scheduled cron, not every event). Pattern mirrors
 * ProposalOutcomeRecorder (Phase 1) and ProposalFileWriter / ProposalGitCommitter (§7.6).
 *
 * Spec 55 §7.7 `docs/specs/55_evolution_system.md:544`
 */

import type { MemoryStore } from "../types/life-system";
import type { Logger } from "../types/logger";
import type { ProposalOutcomePayload, ProposalOutcomeType } from "./proposal-outcome-recorder";

// ── Effect verdict ───────────────────────────────────────

/** Three possible verification verdicts (Spec 55 §7.7 Phase 2). */
export type EffectVerdict = "effect_verified" | "effect_uncertain" | "effect_failed";

// ── Signal payload ───────────────────────────────────────

/**
 * Payload written to MemoryStore for each effect verification signal.
 * Consumers (Insight layer, Phase 3) read these to surface rollback candidates
 * or adjust generator confidence.
 */
export interface EffectVerificationPayload {
  proposalId: string;
  capability: string;
  changeType: string;
  verdict: EffectVerdict;
  successMetric: {
    signalRef?: string;
    baselineValue: number;
    targetValue: number;
    description?: string;
  };
  /** Current value fetched via signalRef. null when no data is available. */
  currentValue: number | null;
  /** ISO 8601 timestamp of verification */
  verifiedAt: string;
  durationMs: number;
}

// ── Per-outcome verification result ─────────────────────

/** Result returned by `verify()` for a single outcome. */
export interface ProposalEffectVerificationResult extends EffectVerificationPayload {
  // same shape — returned to caller AND written as Signal payload
}

// ── Options ──────────────────────────────────────────────

export interface ProposalEffectVerifierOptions {
  store: MemoryStore;
  /**
   * Resolves the current metric value for a given signalRef string.
   * Return `null` if no data is available yet (yields `effect_uncertain`).
   *
   * Default implementation: parses signalRef as `"entity.metric"` or
   * `"entity:metric"` and calls `store.getBaseline(entity, metric)`.
   */
  getCurrentValue?: (signalRef: string) => Promise<number | null>;
  /** Overridable clock for deterministic tests. */
  clock?: () => Date;
  logger?: Logger;
}

// ── Verify-call options ──────────────────────────────────

export interface VerifyEffectOptions {
  /** Outcome payloads to evaluate (typically from ProposalOutcomeRecorder output). */
  outcomes: ProposalOutcomePayload[];
  /**
   * Only evaluate outcomes with this outcome type.
   * Default: `"merged"` — the only outcome where effect verification is meaningful.
   */
  outcomeFilter?: ProposalOutcomeType;
}

// ── ProposalEffectVerifier ────────────────────────────────

export class ProposalEffectVerifier {
  private readonly store: MemoryStore;
  private readonly resolveCurrentValue: (signalRef: string) => Promise<number | null>;
  private readonly clock: () => Date;
  private readonly logger?: Logger;

  constructor(options: ProposalEffectVerifierOptions) {
    this.store = options.store;
    this.clock = options.clock ?? (() => new Date());
    this.logger = options.logger;
    this.resolveCurrentValue = options.getCurrentValue ?? this.defaultGetCurrentValue.bind(this);
  }

  /**
   * Verify effects for all eligible outcomes in the input array.
   * Eligible = `outcome === outcomeFilter` (default "merged") AND `successMetric` is set.
   * Outcomes without `successMetric` are silently skipped.
   */
  async verify(options: VerifyEffectOptions): Promise<ProposalEffectVerificationResult[]> {
    const { outcomes, outcomeFilter = "merged" } = options;

    const eligible = outcomes.filter(
      (o) => o.outcome === outcomeFilter && o.successMetric !== undefined,
    );

    const results: ProposalEffectVerificationResult[] = [];
    for (const outcome of eligible) {
      results.push(await this.verifyOne(outcome));
    }
    return results;
  }

  private async verifyOne(
    outcome: ProposalOutcomePayload,
  ): Promise<ProposalEffectVerificationResult> {
    const start = Date.now();
    // successMetric is guaranteed non-null: verify() filters for it before calling verifyOne
    const sm = outcome.successMetric ?? { baselineValue: 0, targetValue: 0 };

    let currentValue: number | null = null;
    if (sm.signalRef) {
      currentValue = await this.resolveCurrentValue(sm.signalRef);
    }

    const verdict = determineVerdict(currentValue, sm.targetValue);
    const now = this.clock();
    const durationMs = Date.now() - start;

    const payload: EffectVerificationPayload = {
      proposalId: outcome.proposalId,
      capability: outcome.capability,
      changeType: outcome.changeType,
      verdict,
      successMetric: {
        signalRef: sm.signalRef,
        baselineValue: sm.baselineValue,
        targetValue: sm.targetValue,
        description: sm.description,
      },
      currentValue,
      verifiedAt: now.toISOString(),
      durationMs,
    };

    // Write the primary effect signal (proposal:effect:verified|uncertain|failed)
    const verdictSuffix = verdict.replace("effect_", ""); // "verified" | "uncertain" | "failed"
    await this.store.recordSignal({
      type: `proposal:effect:${verdictSuffix}`,
      source: "event_bus",
      timestamp: now,
      payload,
    });

    // On failure: emit a second rollback_candidate signal so the Insight layer
    // can surface a human-reviewed rollback Proposal.
    if (verdict === "effect_failed") {
      await this.store.recordSignal({
        type: "proposal:effect:rollback_candidate",
        source: "event_bus",
        timestamp: now,
        payload,
      });
      this.logger?.info?.(
        `ProposalEffectVerifier: effect_failed for proposal "${outcome.proposalId}" — rollback_candidate emitted`,
        { proposalId: outcome.proposalId, currentValue, targetValue: sm.targetValue },
      );
    } else {
      this.logger?.info?.(
        `ProposalEffectVerifier: ${verdict} for proposal "${outcome.proposalId}"`,
        { proposalId: outcome.proposalId, currentValue, targetValue: sm.targetValue },
      );
    }

    return payload;
  }

  /**
   * Default signalRef resolver: parses `"entity.metric"` or `"entity:metric"` and
   * calls `store.getBaseline(entity, metric)`.
   */
  private async defaultGetCurrentValue(signalRef: string): Promise<number | null> {
    const sep = signalRef.includes(".") ? "." : ":";
    const idx = signalRef.indexOf(sep);
    if (idx === -1) return null;
    const entity = signalRef.slice(0, idx);
    const metric = signalRef.slice(idx + 1);
    const baseline = await this.store.getBaseline(entity, metric);
    return baseline?.value ?? null;
  }
}

// ── Factory ───────────────────────────────────────────────

export function createProposalEffectVerifier(
  options: ProposalEffectVerifierOptions,
): ProposalEffectVerifier {
  return new ProposalEffectVerifier(options);
}

// ── Helpers ───────────────────────────────────────────────

function determineVerdict(currentValue: number | null, targetValue: number): EffectVerdict {
  if (currentValue === null) return "effect_uncertain";
  if (currentValue >= targetValue) return "effect_verified";
  return "effect_failed";
}
