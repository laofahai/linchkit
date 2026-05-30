/**
 * ProposalOutcomeRecorder — Spec 55 §7.7 "Feedback loop".
 *
 * Records Proposal accept/reject/merge/withdraw events to the Memory layer
 * so the system can learn from outcomes. Written outcome signals are the
 * input for Phase 2 (ProposalEffectVerifier) and Phase 3
 * (generator-priority feedback loop).
 *
 * Design mirrors ProposalFileWriter (§7.6): thin, caller-composed, never
 * auto-wired. The caller decides when to invoke and which outcome to record.
 *
 * Typical wiring for the "accepted" path (via ProposalEngine.onApproved):
 *
 *   const recorder = new ProposalOutcomeRecorder({ store });
 *   const engine = new ProposalEngine({
 *     onApproved: recorder.onApprovedHook(),
 *   });
 *
 * For the rejection path (await rejectProposal before recording the outcome):
 *
 *   const proposal = await engine.rejectProposal({ proposalId, reason });
 *   await recorder.recordOutcome(proposal, "rejected");
 */

import type { MemoryStore, Signal } from "../types/life-system";
import type { Logger } from "../types/logger";
import type { ProposalDefinition } from "../types/proposal";

// ── Outcome type ─────────────────────────────────────────────

/**
 * The four Proposal outcome types tracked by the feedback loop (Spec 55 §7.7).
 *
 * - accepted  — proposal was approved by a human (or auto-approval gate)
 * - rejected  — proposal was explicitly rejected
 * - merged    — proposal reached committed/deployed status (change is live)
 * - withdrawn — proposal was manually retracted before a decision
 */
export type ProposalOutcomeType = "accepted" | "rejected" | "merged" | "withdrawn";

// ── Payload ──────────────────────────────────────────────────

/**
 * Structured payload written into the Memory Signal for a Proposal outcome.
 * Future Insight generators query signals of type `proposal:outcome:<outcome>`
 * to compute acceptance ratios by capability, changeType, and authorId.
 */
export interface ProposalOutcomePayload {
  proposalId: string;
  outcome: ProposalOutcomeType;
  capability: string;
  changeType: string;
  authorType: "human" | "ai";
  authorId: string;
  /** Populated when outcome is "accepted". */
  approvedBy?: { type: string; id: string };
  /** Populated when outcome is "rejected". */
  rejectionReason?: string;
  /** Carried through for Phase 2 ProposalEffectVerifier. */
  successMetric?: ProposalDefinition["successMetric"];
  /**
   * Merged commit SHA of the graduated proposal (Spec 55 §7.7 rollback loop).
   *
   * Populated for the "merged" outcome from the `commitSha` that
   * `ProposalGitCommitter.commitAndOpenPR` returns. Threaded forward through the
   * effect-verification → rollback-insight → translator chain so a rollback
   * `target:"revert"` change can carry the EXACT commit to `git revert`. Absent
   * when the merge happened out-of-band or predates SHA capture.
   */
  mergedSha?: string;
  /** ISO-8601 — when the outcome was recorded. */
  outcomeAt: string;
  /** ISO-8601 — when the Proposal was originally created. */
  proposalCreatedAt: string;
}

// ── Options ──────────────────────────────────────────────────

export interface ProposalOutcomeRecorderOptions {
  /** Memory store that receives outcome signals. */
  store: MemoryStore;
  /** Optional structured logger. */
  logger?: Logger;
}

/** Per-call extras for {@link ProposalOutcomeRecorder.recordOutcome}. */
export interface RecordOutcomeOptions {
  /**
   * Merged commit SHA, supplied for the "merged" outcome from the `commitSha`
   * that `ProposalGitCommitter.commitAndOpenPR` returns. Threaded onto the
   * outcome payload so the rollback loop can later revert the exact commit.
   * Ignored (with a warning) for non-"merged" outcomes.
   */
  mergedSha?: string;
}

// ── ProposalOutcomeRecorder ──────────────────────────────────

export class ProposalOutcomeRecorder {
  private readonly store: MemoryStore;
  private readonly logger?: Logger;

  constructor(options: ProposalOutcomeRecorderOptions) {
    this.store = options.store;
    this.logger = options.logger;
  }

  /**
   * Record a Proposal outcome event to the Memory layer.
   *
   * Writes a Signal of type `proposal:outcome:<outcome>` to the configured
   * store. The signal carries enough context for future Insight generators to
   * compute per-generator acceptance ratios without re-fetching the Proposal.
   *
   * For the "merged" outcome, pass `{ mergedSha }` (the `commitSha` returned by
   * `ProposalGitCommitter.commitAndOpenPR`) so the rollback loop can later
   * revert the exact commit. A `mergedSha` on a non-"merged" outcome is ignored
   * with a warning.
   */
  async recordOutcome(
    proposal: ProposalDefinition,
    outcome: ProposalOutcomeType,
    options: RecordOutcomeOptions = {},
  ): Promise<void> {
    const now = new Date();
    const mergedSha = this.resolveMergedSha(proposal.id, outcome, options.mergedSha);
    const payload: ProposalOutcomePayload = {
      proposalId: proposal.id,
      outcome,
      capability: proposal.capability,
      changeType: proposal.changeType,
      authorType: proposal.author.type,
      authorId: proposal.author.id,
      approvedBy: outcome === "accepted" ? proposal.approvedBy : undefined,
      rejectionReason: outcome === "rejected" ? proposal.rejectionReason : undefined,
      successMetric: proposal.successMetric,
      mergedSha,
      outcomeAt: now.toISOString(),
      proposalCreatedAt: proposal.createdAt.toISOString(),
    };

    const signal: Signal = {
      type: `proposal:outcome:${outcome}`,
      source: "event_bus",
      timestamp: now,
      payload,
    };

    await this.store.recordSignal(signal);

    this.logger?.info?.(
      `ProposalOutcomeRecorder: recorded "${outcome}" for proposal "${proposal.id}"`,
      { proposalId: proposal.id, outcome, capability: proposal.capability },
    );
  }

  /**
   * Resolve the `mergedSha` to stamp onto the outcome payload.
   *
   * - "merged" outcome: returns the supplied SHA verbatim (or `undefined` when
   *   the caller did not provide one — e.g. an out-of-band merge).
   * - Any other outcome: a SHA is meaningless, so it is dropped and a warning is
   *   logged. The SHA only describes a graduated commit, which exists solely for
   *   the "merged" outcome.
   */
  private resolveMergedSha(
    proposalId: string,
    outcome: ProposalOutcomeType,
    mergedSha: string | undefined,
  ): string | undefined {
    if (outcome === "merged") {
      // Trim and drop empty/whitespace-only values so only a real SHA is stored
      // (and never propagated downstream as a junk revertSha).
      const trimmed = mergedSha?.trim();
      return trimmed && trimmed.length > 0 ? trimmed : undefined;
    }
    if (mergedSha !== undefined) {
      this.logger?.warn?.(
        `ProposalOutcomeRecorder: ignoring mergedSha for non-"merged" outcome "${outcome}" on proposal "${proposalId}"`,
      );
    }
    return undefined;
  }

  /**
   * Returns an OnApprovedHook-compatible function for wiring into
   * ProposalEngine({ onApproved: recorder.onApprovedHook() }).
   *
   * The returned hook records outcome "accepted" for every approved Proposal.
   * Hook failures propagate to the caller (ProposalEngine captures them in
   * proposal.persistenceError — the approval itself is never rolled back).
   */
  onApprovedHook(): (proposal: ProposalDefinition) => Promise<void> {
    return (proposal) => this.recordOutcome(proposal, "accepted");
  }
}

// ── Factory ──────────────────────────────────────────────────

export function createProposalOutcomeRecorder(
  options: ProposalOutcomeRecorderOptions,
): ProposalOutcomeRecorder {
  return new ProposalOutcomeRecorder(options);
}
