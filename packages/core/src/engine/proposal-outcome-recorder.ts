/**
 * ProposalOutcomeRecorder — Spec 55 §7.7 Phase 1 "Feedback loop: outcome recording".
 *
 * Records proposal accept/reject/merge/withdraw events to MemoryStore so the
 * Awareness and Insight layers can learn from acceptance patterns over time.
 * Phase 3 will aggregate these events by (generator_id, change_type) to adjust
 * generator attention budgets.
 *
 * Intentionally NOT auto-wired into ProposalEngine. Callers compose it:
 *   const recorder = new ProposalOutcomeRecorder({ store });
 *   const engine = createProposalEngine({
 *     onApproved: (p) => recorder.record({ proposal: p, outcome: 'accepted' }),
 *     onRejected: (p) => recorder.record({ proposal: p, outcome: 'rejected' }),
 *   });
 *
 * Pattern mirrors ProposalFileWriter / ProposalGitCommitter (Spec 55 §7.6).
 */

import type { MemoryStore } from "../types/life-system";
import type { Logger } from "../types/logger";
import type { ProposalDefinition } from "../types/proposal";

// ── Outcome types ────────────────────────────────────────

/** The four outcome types a Proposal can produce (Spec 55 §7.7). */
export type ProposalOutcomeType = "accepted" | "rejected" | "merged" | "withdrawn";

// ── Signal payload ───────────────────────────────────────

/**
 * Payload written to MemoryStore for each outcome event.
 * Phase 3 reads these by (generatorId, changeType) to adjust generator weights.
 */
export interface ProposalOutcomePayload {
  proposalId: string;
  capability: string;
  changeType: string;
  outcome: ProposalOutcomeType;
  /** Generator that produced the proposal, if known (used by Phase 3). */
  generatorId?: string;
  successMetric?: {
    baselineValue: number;
    targetValue: number;
    signalRef?: string;
    description?: string;
  };
  actorId?: string;
  reason?: string;
  recordedAt: string;
}

// ── Options ──────────────────────────────────────────────

export interface ProposalOutcomeRecorderOptions {
  store: MemoryStore;
  logger?: Logger;
}

// ── Record options ───────────────────────────────────────

export interface RecordOutcomeOptions {
  proposal: ProposalDefinition;
  outcome: ProposalOutcomeType;
  /** ID of the human or system actor who triggered this outcome. */
  actorId?: string;
  /** Reason text (most useful for rejected / withdrawn outcomes). */
  reason?: string;
}

// ── ProposalOutcomeRecorder ──────────────────────────────

export class ProposalOutcomeRecorder {
  private readonly store: MemoryStore;
  private readonly logger?: Logger;

  constructor(options: ProposalOutcomeRecorderOptions) {
    this.store = options.store;
    this.logger = options.logger;
  }

  /**
   * Record a proposal outcome event to MemoryStore.
   *
   * The signal type follows the convention `proposal:outcome:<type>` so
   * queries can filter by outcome without parsing the payload.
   */
  async record(options: RecordOutcomeOptions): Promise<void> {
    const { proposal, outcome, actorId, reason } = options;

    // Read generatorId if the caller attached it as a sidecar (Phase 3 uses this).
    const generatorId = (proposal as { generatorId?: unknown }).generatorId;

    const payload: ProposalOutcomePayload = {
      proposalId: proposal.id,
      capability: proposal.capability,
      changeType: proposal.changeType,
      outcome,
      generatorId: typeof generatorId === "string" ? generatorId : undefined,
      successMetric: proposal.successMetric,
      actorId,
      reason,
      recordedAt: new Date().toISOString(),
    };

    await this.store.recordSignal({
      type: `proposal:outcome:${outcome}`,
      source: "event_bus",
      timestamp: new Date(),
      payload,
    });

    this.logger?.info?.(
      `ProposalOutcomeRecorder: recorded "${outcome}" for proposal "${proposal.id}"`,
      { proposalId: proposal.id, outcome, capability: proposal.capability },
    );
  }
}

// ── Factory ──────────────────────────────────────────────

export function createProposalOutcomeRecorder(
  options: ProposalOutcomeRecorderOptions,
): ProposalOutcomeRecorder {
  return new ProposalOutcomeRecorder(options);
}
