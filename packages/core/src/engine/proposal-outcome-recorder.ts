/**
 * ProposalOutcomeRecorder — Spec 55 §7.7 "Feedback loop: Phase 1".
 *
 * Records Proposal accept/reject/merge/withdraw events to the Memory layer
 * so future Insight generation can reference the accept/reject history and
 * the `ProposalEffectVerifier` (Phase 2) can verify `successMetric` outcomes.
 *
 * Design constraints (mirrors ProposalFileWriter / ProposalGitCommitter):
 *   - Small, focused engine — no business logic, no scheduling.
 *   - Caller-composed — NOT auto-wired into ProposalEngine. The caller
 *     decides when to record (typically right after approveProposal /
 *     rejectProposal / commitProposal) so the project retains full control
 *     over the feedback-loop timing.
 *   - Writes via MemoryStore.recordSignal() — decoupled from any specific
 *     storage backend (in-memory, Drizzle, external).
 */

import type { MemoryStore } from "../types/life-system";
import type { ProposalDefinition } from "../types/proposal";

// ── Outcome type ─────────────────────────────────────────

/**
 * Four outcome types tracked by the feedback loop (Spec 55 §7.7):
 * - `accepted`  — proposal approved by a human/AI reviewer
 * - `rejected`  — proposal rejected by a human/AI reviewer
 * - `merged`    — proposal committed + deployed (graduated to Layer 0)
 * - `withdrawn` — proposal withdrawn by its author before a decision
 */
export type ProposalOutcomeType = "accepted" | "rejected" | "merged" | "withdrawn";

// ── Signal type constant ─────────────────────────────────

/** Prefix for all outcome signal types written to MemoryStore. */
const OUTCOME_SIGNAL_PREFIX = "proposal_outcome" as const;

// ── Options ──────────────────────────────────────────────

export interface ProposalOutcomeRecorderOptions {
  /** Memory store to write outcome signals to. */
  store: MemoryStore;
}

// ── Record input ─────────────────────────────────────────

export interface RecordProposalOutcomeOptions {
  /** The proposal whose outcome is being recorded. */
  proposal: ProposalDefinition;
  /** The outcome to record. */
  outcome: ProposalOutcomeType;
  /** Optional human-readable reason (required for "rejected" and "withdrawn", optional otherwise). */
  reason?: string;
  /** Override the event timestamp. Defaults to `new Date()`. */
  timestamp?: Date;
}

// ── Recorded signal payload ──────────────────────────────

/** Shape of the `payload` field written to MemoryStore for each outcome event. */
export interface ProposalOutcomePayload {
  proposalId: string;
  proposalTitle: string;
  capability: string;
  changeType: string;
  outcome: ProposalOutcomeType;
  authorId: string;
  authorType: string;
  reason?: string;
  successMetric?: ProposalDefinition["successMetric"];
}

// ── ProposalOutcomeRecorder ──────────────────────────────

export class ProposalOutcomeRecorder {
  private readonly store: MemoryStore;

  constructor(opts: ProposalOutcomeRecorderOptions) {
    this.store = opts.store;
  }

  /**
   * Record a single outcome event for a Proposal.
   *
   * Writes a Signal to the Memory store with:
   *   type     = `"proposal_outcome:{outcome}"` (e.g. `"proposal_outcome:accepted"`)
   *   source   = `"event_bus"` (internal lifecycle event)
   *   payload  = {@link ProposalOutcomePayload}
   *
   * The signal type uses a structured prefix so downstream queries and the
   * future `ProposalEffectVerifier` can filter by outcome kind without
   * parsing free-form strings.
   */
  async recordOutcome(opts: RecordProposalOutcomeOptions): Promise<void> {
    const { proposal, outcome, reason, timestamp } = opts;

    const payload: ProposalOutcomePayload = {
      proposalId: proposal.id,
      proposalTitle: proposal.title,
      capability: proposal.capability,
      changeType: proposal.changeType,
      outcome,
      authorId: proposal.author.id,
      authorType: proposal.author.type,
      ...(reason !== undefined && { reason }),
      ...(proposal.successMetric !== undefined && {
        successMetric: structuredClone(proposal.successMetric),
      }),
    };

    await this.store.recordSignal({
      type: `${OUTCOME_SIGNAL_PREFIX}:${outcome}`,
      source: "event_bus",
      timestamp: timestamp ?? new Date(),
      payload,
    });
  }
}

// ── Factory ───────────────────────────────────────────────

/** Create a new ProposalOutcomeRecorder instance. */
export function createProposalOutcomeRecorder(
  opts: ProposalOutcomeRecorderOptions,
): ProposalOutcomeRecorder {
  return new ProposalOutcomeRecorder(opts);
}
