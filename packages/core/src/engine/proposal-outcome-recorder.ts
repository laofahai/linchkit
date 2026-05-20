/**
 * ProposalOutcomeRecorder — Spec 55 §7.7 "Feedback loop: Phase 1".
 *
 * Records Proposal accept / reject / merge / withdraw events into the
 * MemoryStore so future Insight generation and the Phase 2
 * `ProposalEffectVerifier` can reference the outcome history.
 *
 * Composition model (mirrors ProposalFileWriter / ProposalGitCommitter):
 *   - NOT auto-wired into ProposalEngine. The caller composes.
 *   - Typical usage: wire into `ProposalEngine.onApproved` for "accepted"
 *     and call directly after `rejectProposal` / `withdrawProposal` for the
 *     other outcome types.
 *   - One `record()` call per outcome event — idempotency is the caller's
 *     responsibility (the store is append-only from this engine's POV).
 */

import type { MemoryStore, SignalSource } from "../types/life-system";
import type { ChangeType, ProposalDefinition, ProposalSuccessMetric } from "../types/proposal";

// ── Outcome types ────────────────────────────────────────

/** The four outcome events tracked by §7.7 feedback loop. */
export type ProposalOutcomeType = "accepted" | "rejected" | "merged" | "withdrawn";

// ── Signal constants ─────────────────────────────────────

const OUTCOME_SIGNAL_SOURCE: SignalSource = "event_bus";

// ── Payload written to MemoryStore ───────────────────────

/**
 * Structured payload stored as a MemoryStore Signal for every Proposal outcome.
 *
 * Phase 2 `ProposalEffectVerifier` reads records by `proposalId` or by
 * `capability` + `outcome` to compute per-generator acceptance ratios.
 */
export interface ProposalOutcomeRecord {
  proposalId: string;
  capability: string;
  changeType: ChangeType;
  outcome: ProposalOutcomeType;
  /** ISO-8601 timestamp when the outcome was recorded. */
  recordedAt: string;
  /** Rejection reason (only present when outcome === "rejected"). */
  reason?: string;
  /** Copied from `ProposalDefinition.successMetric` when set. */
  successMetric?: ProposalSuccessMetric;
}

// ── Options ──────────────────────────────────────────────

export interface ProposalOutcomeRecorderOptions {
  /** MemoryStore to write outcome events into. */
  store: MemoryStore;
  /** Structured logger (optional). */
  logger?: {
    info?: (msg: string, meta?: Record<string, unknown>) => void;
    warn?: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

// ── ProposalOutcomeRecorder ──────────────────────────────

export class ProposalOutcomeRecorder {
  private readonly store: MemoryStore;
  private readonly logger?: ProposalOutcomeRecorderOptions["logger"];

  constructor(options: ProposalOutcomeRecorderOptions) {
    this.store = options.store;
    this.logger = options.logger;
  }

  /**
   * Record a Proposal outcome event into the MemoryStore.
   *
   * Writes a `Signal` with `type = "proposal.outcome.<outcomeType>"` so
   * consumers can query by type prefix to retrieve all outcome signals.
   *
   * Calling `record()` on a proposal whose status does not match the
   * outcome type is allowed — the caller is responsible for invoking this
   * at the right lifecycle point. The recorder never rejects a valid
   * `ProposalDefinition` based on status; it is a pure writer.
   */
  async record(proposal: ProposalDefinition, outcome: ProposalOutcomeType): Promise<void> {
    const recordedAt = new Date();

    const outcomeRecord: ProposalOutcomeRecord = {
      proposalId: proposal.id,
      capability: proposal.capability,
      changeType: proposal.changeType,
      outcome,
      recordedAt: recordedAt.toISOString(),
      ...(outcome === "rejected" && proposal.rejectionReason
        ? { reason: proposal.rejectionReason }
        : {}),
      ...(proposal.successMetric ? { successMetric: { ...proposal.successMetric } } : {}),
    };

    await this.store.recordSignal({
      type: `proposal.outcome.${outcome}`,
      source: OUTCOME_SIGNAL_SOURCE,
      timestamp: recordedAt,
      payload: outcomeRecord,
    });

    this.logger?.info?.(
      `ProposalOutcomeRecorder: recorded "${outcome}" for proposal "${proposal.id}"`,
      { proposalId: proposal.id, capability: proposal.capability, outcome },
    );
  }
}

// ── Factory ──────────────────────────────────────────────

export function createProposalOutcomeRecorder(
  options: ProposalOutcomeRecorderOptions,
): ProposalOutcomeRecorder {
  return new ProposalOutcomeRecorder(options);
}
