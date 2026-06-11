/**
 * Evolution-cycle → governance-draft bridge (Spec 55 §7).
 *
 * The Spec 55 evolution loop produces `ProposalDefinition[]` as TRANSIENT
 * cycle output (`EvolutionCycleResult.proposals`). Those objects never reach
 * the governance review pipeline on their own, so a human can never review
 * them. This helper closes that gap on the SAFE side: it persists each cycle
 * proposal as a NEW `draft` in the shared {@link ProposalEngine}, deduping
 * against the engine's already-pending set so re-running a cycle does not pile
 * up duplicate drafts.
 *
 * Hard safety boundary (matches the repo principle "AI Never Modifies
 * Production Directly"):
 *  - Drafts are created via `ProposalEngine.createProposal`, which ALWAYS lands
 *    them in `draft` status. This helper NEVER submits, validates, approves,
 *    commits, deploys, or graduates a proposal. The existing human review →
 *    approval pipeline stays untouched.
 *  - There is no scheduler/timer here — invocation cadence is the caller's
 *    concern (this is an on-demand bridge only).
 */

import type { ProposalPreAnalysisResult } from "../life-system/proposal-preanalysis/types";
import type { ProposalDefinition } from "../types/proposal";
import type { CreateProposalOptions, ProposalEngine } from "./proposal-engine";

/**
 * Statuses considered "active" for dedup purposes — a proposal already in, or
 * already accepted by, the human review pipeline. `approved` is included: an
 * approved-but-not-yet-graduated proposal is accepted work, so re-running the
 * cycle must not surface a duplicate draft for it. We do NOT dedup against
 * `rejected` (a previously-rejected but recurring insight should re-surface a
 * fresh draft for re-review), nor against the landed terminal statuses
 * `committed` / `deployed` (a regression after landing may legitimately
 * re-propose the same change).
 */
const PENDING_STATUSES: ReadonlySet<string> = new Set([
  "draft",
  "validating",
  "validated",
  "approved",
]);

/** Summary returned by {@link persistCycleProposalsAsDrafts}. */
export interface PersistCycleDraftsResult {
  /** Number of cycle proposals newly persisted as `draft`. */
  created: number;
  /** Number of cycle proposals skipped because an equivalent draft is already pending. */
  deduped: number;
  /** Total cycle proposals considered (`created + deduped`). */
  total: number;
  /** Engine ids of the drafts created this run (in input order). */
  createdIds: string[];
}

/** Options for {@link persistCycleProposalsAsDrafts}. */
export interface PersistCycleDraftsOptions {
  /** Proposals emitted by an evolution cycle (`EvolutionCycleResult.proposals`). */
  proposals: ProposalDefinition[];
  /** Shared governance engine the review UI reads from. */
  engine: ProposalEngine;
  /**
   * Optional per-proposal pre-analysis envelopes for this cycle
   * (`EvolutionCycleResult.proposalAnalyses`). Each entry is matched to its
   * source proposal by `proposalId` (which equals the cycle proposal's `id` at
   * analysis time) and attached to the created draft as read-only review
   * metadata. When omitted — or when no entry matches a given proposal — the
   * draft is created without an `analysis` field. Attaching analysis NEVER
   * changes dedup, validation, approval, or graduation behavior.
   */
  proposalAnalyses?: ProposalPreAnalysisResult[];
}

/**
 * Build a stable dedup key for a proposal: its capability plus the sorted set
 * of its change names. This mirrors the existing PatternDetector dedup
 * heuristic in `proposal-api.ts` (capability + change-name match) but extends
 * it to the full change set so two proposals touching the same capability with
 * different changes are NOT collapsed.
 */
function dedupKey(capability: string, changeNames: string[]): string {
  const sorted = [...changeNames].sort();
  return `${capability}::${sorted.join(",")}`;
}

/**
 * Persist each cycle proposal as a `draft` in the shared {@link ProposalEngine},
 * skipping any that duplicate an already-pending draft.
 *
 * Dedup heuristic: a cycle proposal is considered a duplicate when the engine
 * already holds a PENDING proposal (`draft` / `validating` / `validated`) with
 * the same {@link dedupKey} (capability + change-name set). This mirrors the
 * pre-create dedup the `POST /api/proposals` insight path uses, applied to the
 * batch so re-running the same cycle is idempotent.
 *
 * The source `ProposalDefinition` is mapped onto `createProposal` faithfully:
 * `title`, `description`, `author`, `capability`, `changeType`, and `changes`
 * carry over verbatim. The engine assigns a fresh id, recomputes auto-impact,
 * and stamps `status: "draft"` — we never copy the source id or status, so a
 * cycle proposal can only ever ENTER the pipeline as a new draft.
 *
 * Pre-analysis: when `options.proposalAnalyses` is supplied
 * (`EvolutionCycleResult.proposalAnalyses`), each created draft is enriched with
 * its matching pre-analysis envelope (dedup / conflict / impact / backtest) so a
 * human reviewer can see the evidence behind an AI-surfaced proposal. The match
 * is keyed on `proposalId` (which equals the source cycle proposal's `id` at
 * analysis time). This is read-only review metadata — it never affects the
 * draft's status, dedup, or any downstream gate.
 */
export function persistCycleProposalsAsDrafts(
  options: PersistCycleDraftsOptions,
): PersistCycleDraftsResult {
  const { proposals, engine, proposalAnalyses } = options;

  // Index the pre-analysis envelopes by their `proposalId` for O(1) lookup
  // against each source cycle proposal's `id`. Built once; empty when no
  // analyses were supplied so the attach step is a no-op.
  const analysisById = new Map<string, ProposalPreAnalysisResult>();
  for (const analysis of proposalAnalyses ?? []) {
    if (analysis?.proposalId) {
      analysisById.set(analysis.proposalId, analysis);
    }
  }

  // Snapshot the engine's currently-pending dedup keys ONCE up front. We then
  // augment this set as we create new drafts so duplicates WITHIN a single
  // cycle batch are also collapsed (a translator could, in principle, emit two
  // structurally-identical proposals in one run).
  const pendingKeys = new Set<string>();
  for (const existing of engine.listProposals({})) {
    if (PENDING_STATUSES.has(existing.status)) {
      pendingKeys.add(
        dedupKey(
          existing.capability,
          // Defensive: `changes` is required by the type, but a proposal loaded
          // from persistent/external storage could be malformed. One bad row
          // must not crash dedup over the whole pending set.
          (existing.changes ?? []).map((c) => c.name),
        ),
      );
    }
  }

  const createdIds: string[] = [];
  let deduped = 0;

  for (const proposal of proposals) {
    const key = dedupKey(
      proposal.capability,
      // Defensive: guard a malformed cycle proposal with no `changes` so a
      // partially-initialized translator output can't crash the batch.
      (proposal.changes ?? []).map((c) => c.name),
    );
    if (pendingKeys.has(key)) {
      deduped += 1;
      continue;
    }

    // Match this cycle proposal to its pre-analysis envelope by id (the
    // analysis carries the source proposal's id as `proposalId`). Omitted when
    // no analyses were supplied or none match.
    const analysis = analysisById.get(proposal.id);

    const createOptions: CreateProposalOptions = {
      title: proposal.title,
      description: proposal.description,
      author: proposal.author,
      capability: proposal.capability,
      changeType: proposal.changeType,
      changes: proposal.changes,
      ...(analysis ? { analysis } : {}),
    };
    const draft = engine.createProposal(createOptions);
    createdIds.push(draft.id);
    // Record the key so a duplicate later in THIS batch is also deduped.
    pendingKeys.add(key);
  }

  return {
    created: createdIds.length,
    deduped,
    total: proposals.length,
    createdIds,
  };
}
