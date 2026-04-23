/**
 * Proposal Pre-Analysis types — Spec 55 §7.3.
 *
 * Before a Proposal reaches a human reviewer (or an AI gate), the system runs a
 * pipeline of analyzers that annotate the Proposal with structured metadata.
 * Four stages are defined by Spec 55 §7.3:
 *
 *   1. Deduplication — near/exact match against pending proposals.
 *   2. Conflict detection — contradiction with active Rules / State machines / other proposals.
 *   3. Impact estimation — how many records / users / tenants are affected.
 *   4. Backtest — replay against historical data to estimate the delta.
 *
 * This module ships stages 1 and 3 (dedup + impact) with clean extension points
 * so stages 2 and 4 can be added without refactoring.
 */

import type { ProposalDefinition } from "../../types/proposal";

// ── Stage identifiers ───────────────────────────────────────

/** The four pre-analysis stages from Spec 55 §7.3. */
export type PreAnalysisStage = "dedup" | "conflict" | "impact" | "backtest";

// ── Stage result shapes ─────────────────────────────────────

/**
 * Result for the deduplication stage (Spec 55 §7.3 stage 1).
 *
 * A Proposal is considered similar when it targets the same entity, uses the same
 * change operation, and its payload hash collides with an already-pending proposal.
 * An exact match additionally has identical payload hash AND identical change set length.
 */
export interface DedupResult {
  /** Pending proposals that overlap with the candidate by structural equality. */
  similar: ProposalDefinition[];
  /** A single proposal that matches exactly (null if none). */
  exactMatch: ProposalDefinition | null;
  /** Stable hash of the candidate's change set, for debugging / downstream comparison. */
  payloadHash: string;
}

/**
 * Result for the impact estimation stage (Spec 55 §7.3 stage 3).
 *
 * For data-changing proposals (entity, state transitions, overlays) this is a count
 * against the target entity. For code-only changes (view / action definitions that
 * don't mutate stored records) the count is 0 and `reason` explains why.
 */
export interface ImpactResult {
  /** Estimated number of records affected if the proposal is applied. */
  affectedRecordCount: number;
  /** A small sample of record IDs that would be affected (bounded, not exhaustive). */
  sampleRecordIds: string[];
  /** Optional explanation when the count is zero by design (e.g. "not-a-data-change"). */
  reason?: string;
  /** Entities the analyzer probed — useful when a proposal touches multiple entities. */
  probedEntities: string[];
}

/**
 * Placeholder result for the conflict detection stage (Spec 55 §7.3 stage 2).
 *
 * The type is defined here so the pipeline can wire in a conflict analyzer later
 * without changing any of the surrounding code.
 */
export interface ConflictResult {
  /** Conflicts detected against active Rules / States / pending Proposals. */
  conflicts: ConflictFinding[];
  /** Free-form notes from the analyzer (e.g. which sources were checked). */
  notes?: string;
}

/** A single conflict finding. Kept generic so concrete analyzers can populate it. */
export interface ConflictFinding {
  /** What kind of artifact the candidate conflicts with. */
  kind: "rule" | "state_transition" | "proposal" | "other";
  /** The conflicting artifact's identifier (rule name, proposal id, etc). */
  targetId: string;
  /** Human-readable description of the conflict. */
  message: string;
}

/**
 * Placeholder result for the backtest stage (Spec 55 §7.3 stage 4).
 *
 * Backtest replays the proposal against historical data and reports counter-factual
 * deltas. Left as a type so follow-up work can wire in an implementation.
 */
export interface BacktestResult {
  /** How far back the backtest ran. */
  windowDays: number;
  /** Number of historical records the proposal would have changed. */
  hypotheticalTriggerCount: number;
  /** Optional free-form summary (e.g. "18 of 23 later rejected"). */
  summary?: string;
}

// ── Per-stage envelope ──────────────────────────────────────

/** Outcome status for a single analyzer run. */
export type PreAnalysisStatus = "ok" | "skipped" | "error";

/**
 * Envelope that wraps a per-stage analyzer result.
 *
 * The envelope is used so one analyzer failing does not nuke the pipeline — the
 * error is captured into the stage's result and the remaining analyzers still run.
 */
export interface PreAnalysisStageResult<TData = unknown> {
  stage: PreAnalysisStage;
  status: PreAnalysisStatus;
  data?: TData;
  /** Populated when status === "error". */
  error?: { code: string; message: string };
  /** Wall-clock duration in ms. */
  durationMs: number;
}

// ── Analyzer contract ───────────────────────────────────────

/**
 * A pre-analysis analyzer. Each analyzer owns a single stage and returns a typed
 * result wrapped in the PreAnalysisStageResult envelope by the pipeline runner.
 *
 * The generic `TName` parameter pins the stage at the type level so analyzer
 * arrays can stay heterogeneous while still being type-safe to consume.
 */
export interface PreAnalyzer<TStage extends PreAnalysisStage = PreAnalysisStage, TData = unknown> {
  /** Which stage this analyzer belongs to. */
  readonly stage: TStage;
  /** Human-readable name, used in error envelopes and logs. */
  readonly name: string;
  /** Run the analyzer against a proposal. Throw to populate the error envelope. */
  analyze(proposal: ProposalDefinition): Promise<TData>;
}

// ── Aggregate pipeline result ───────────────────────────────

/**
 * The final object returned by PreAnalysisPipeline.analyze(). Contains the proposal
 * id for traceability plus every stage's envelope. Consumers look up stages by key
 * rather than position so stages 2 and 4 can be added without breaking downstream code.
 */
export interface ProposalPreAnalysisResult {
  proposalId: string;
  analyzedAt: Date;
  stages: {
    dedup?: PreAnalysisStageResult<DedupResult>;
    conflict?: PreAnalysisStageResult<ConflictResult>;
    impact?: PreAnalysisStageResult<ImpactResult>;
    backtest?: PreAnalysisStageResult<BacktestResult>;
  };
  /** True if every analyzer returned status === "ok". */
  allStagesSucceeded: boolean;
  /** Total wall-clock duration in ms for the whole pipeline. */
  totalDurationMs: number;
}

// ── Pipeline contract ───────────────────────────────────────

/**
 * PreAnalysisPipeline — orchestrates one or more analyzers against a proposal.
 *
 * Construction is via `createPreAnalysisPipeline({ analyzers })`. The pipeline
 * runs every analyzer exactly once, captures per-stage envelopes, and never
 * throws from `analyze()` — analyzer errors are recorded into the envelope.
 */
export interface PreAnalysisPipeline {
  analyze(proposal: ProposalDefinition): Promise<ProposalPreAnalysisResult>;
}

// ── Pending proposal store (dependency for dedup analyzer) ──

/**
 * Minimal read-only store contract the dedup analyzer uses to fetch the current
 * pending-proposal set. Keeping the contract narrow means any proposal backend
 * (ProposalEngine, a capability's repository, an in-memory test double) can satisfy it.
 */
export interface PendingProposalStore {
  /** Return every proposal currently in a pending-review status. */
  listPending(): Promise<ProposalDefinition[]>;
}

// ── Data provider (dependency for impact analyzer) ──────────

/**
 * Minimal read-only data provider contract the impact analyzer uses. Only supports
 * counting records and fetching a small sample — deliberately narrow to keep the
 * analyzer swappable across Drizzle / InMemoryStore / test doubles.
 */
export interface ImpactDataProvider {
  /** Return the number of records matching an entity + optional filter. */
  countRecords(entity: string, filter?: Record<string, unknown>): Promise<number>;
  /** Return up to `limit` record IDs matching the filter. */
  sampleRecordIds(
    entity: string,
    limit: number,
    filter?: Record<string, unknown>,
  ): Promise<string[]>;
}
