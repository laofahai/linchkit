/**
 * Proposal type definitions
 *
 * Proposal is a change governance unit. All modifications to a Capability must go through
 * the Propose → Validate → Approve → Commit → Deploy pipeline.
 * AI can never directly modify production — every change must be proposed and validated first.
 */

import type { ProposalPreAnalysisResult } from "../life-system/proposal-preanalysis/types";
import type { ImpactNode } from "../ontology/impact-analysis";
import type { ActionDefinition } from "./action";
import type { EntityDefinition } from "./entity";
import type { EventDefinition } from "./event";
import type { FieldOverlayDefinition } from "./overlay";
import type { RuleDefinition } from "./rule";
import type { StateDefinition } from "./state";
import type { ViewDefinition } from "./view";

// ── Proposal status ──────────────────────────────────────

export type ProposalStatus =
  | "draft"
  | "validating"
  | "validated"
  | "approved"
  | "rejected"
  | "committed"
  | "deployed";

// ── Change type (determines approval requirements) ──────────────

export type ChangeType = "patch" | "minor" | "major";

// ── Proposal author ──────────────────────────────────────

export interface ProposalAuthor {
  type: "human" | "ai";
  id: string;
  name: string;
}

// ── Proposal change ──────────────────────────────────────

export type ProposalChangeTarget =
  | "entity"
  | "action"
  | "rule"
  | "view"
  | "state"
  | "event"
  | "flow"
  | "overlay"
  /**
   * Revert a previously-merged Proposal (Spec 55 §7.7 Phase 2 rollback loop).
   * A revert change carries no definition file; its `name` is a fixed,
   * validation-safe identifier (`"revert"`) and the proposalId to roll back is
   * carried in the change `diff` and the proposal's evidence sidecar
   * (`evidence.context.revertProposalId`). Phase-1 validation skips the
   * MISSING_DEFINITION requirement for these changes, and the on-disk
   * ProposalFileWriter SKIPS them; the actual rollback is performed by a
   * separate, human-approved deploy step.
   */
  | "revert";

export type ProposalChangeOperation = "create" | "update" | "delete";

export type ChangeDefinition =
  | EntityDefinition
  | ActionDefinition
  | RuleDefinition
  | ViewDefinition
  | StateDefinition
  | EventDefinition
  | OverlayChangeDefinition;

/** Overlay-specific change definition — carries field overlay details */
export interface OverlayChangeDefinition {
  /** Discriminator — always "overlay" for overlay changes */
  kind: "overlay";
  /** Target entity name */
  entityName: string;
  /** Field overlay definition (for create/update) */
  overlay: FieldOverlayDefinition;
}

export interface ProposalChange {
  /** What type of definition is being changed */
  target: ProposalChangeTarget;
  /** What operation is being performed */
  operation: ProposalChangeOperation;
  /** Name of the definition being changed */
  name: string;
  /** The definition object (for create/update) */
  definition?: ChangeDefinition;
  /** Human-readable diff description (for updates) */
  diff?: string;
  /**
   * The merged commit SHA to revert (Spec 55 §7.7 rollback loop).
   *
   * Only meaningful on a `target:"revert"` change. Carries the commit SHA of
   * the regressed proposal — captured when that proposal graduated to a PR via
   * `ProposalGitCommitter` and threaded through the
   * outcome → effect-verification → rollback-insight → translator chain — so a
   * rollback executor (`DeployRollbackOrchestrator`) can `git revert` the
   * CORRECT commit instead of only naming the reverted proposal.
   *
   * Optional: the upstream chain may lack the SHA (e.g. the original proposal
   * predates SHA capture, or merged out-of-band). When absent, the rollback
   * draft is still produced and the human reviewer must supply the SHA before
   * a rollback can execute. This field NEVER triggers auto-execution.
   */
  revertSha?: string;
  /**
   * AI-materialized TypeScript source for this change (G5 Phase 3).
   *
   * Only set for code targets whose logic body cannot be expressed declaratively
   * in `definition` — today that is an `action` (its `handler` function).
   * Produced by the proposal materializer, build-checked by validation Phase 2,
   * and written verbatim by `ProposalFileWriter` at graduation (preferred over
   * the deterministic codegen). Candidate source only — it never executes or
   * lands without passing validation and double human review (draft + graduation
   * PR).
   */
  generatedSource?: string;
  /**
   * Durable status of the LAST materialization attempt for this change (G5 Phase 4).
   *
   * The materializer stamps this on every MATERIALIZABLE change so a reviewer
   * reading the PERSISTED proposal (GET /api/proposals/:id) can distinguish a
   * change that was never materialized (undefined) from one whose generated
   * source FAILED the build/syntax gate ("failed", reason in
   * `materializationErrors`) or succeeded ("materialized", source in
   * `generatedSource`). Unlike the transient POST /materialize `outcomes` array,
   * this is durable on the change. Declarative / skipped changes leave it
   * undefined. Candidate signal only — it never auto-advances the proposal.
   */
  materializationStatus?: "materialized" | "failed";
  /**
   * Build/syntax-gate errors from the final FAILED materialization attempt — set
   * only when `materializationStatus === "failed"`. Cleared on a successful
   * (re-)materialization. Lets the human reviewer see WHY a change has no
   * candidate source without re-running materialization.
   */
  materializationErrors?: string[];
}

// ── Impact analysis ──────────────────────────────────────

export interface ProposalImpact {
  schemasAffected: string[];
  actionsAffected: string[];
  rulesAffected: string[];
  dependentsAffected: string[];
  migrationRequired: boolean;
  /** Cascading impacts from semantic relation graph analysis */
  cascadingImpacts?: ImpactNode[];
}

// ── Validation types ─────────────────────────────────────

export type ValidationPhase = 1 | 2 | 3 | 4;

export type ValidationPhaseStatus = "passed" | "failed" | "skipped";

export interface ValidationError {
  code: string;
  message: string;
  target?: string;
  field?: string;
}

export interface ValidationWarning {
  code: string;
  message: string;
  target?: string;
  field?: string;
}

export interface PhaseResult {
  phase: ValidationPhase;
  status: ValidationPhaseStatus;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  duration: number;
}

export interface ProposalValidationResult {
  passed: boolean;
  phases: PhaseResult[];
  impactSummary: string;
}

// ── AI Proposal Generation ──────────────────────────────

/** Request for AI-powered proposal generation from natural language */
export interface ProposalRequest {
  /** Natural language description, e.g. "Add a priority field to Task schema" */
  description: string;
  /** Target capability name (optional — AI may infer from context) */
  targetCapability?: string;
  /** Additional hints for the AI (e.g. field type preferences, constraints) */
  context?: Record<string, unknown>;
}

/** AI Proposal Generator — takes natural language and produces structured Proposals */
export interface ProposalGenerator {
  /** Generate a Proposal from a natural language request */
  generate(request: ProposalRequest): Promise<ProposalDefinition>;
  /** Validate a proposal's changes for correctness */
  validate(proposal: ProposalDefinition): Promise<ProposalValidationResult>;
}

// ── Success metric (Spec 55 §7.7) ───────────────────────

/**
 * Optional success metric attached to a Proposal (Spec 55 §7.7).
 *
 * Consumed by Phase 2 `ProposalEffectVerifier` to determine whether the
 * change achieved its intended outcome after merging.
 */
export interface SuccessMetric {
  /** Human-readable description of what success looks like. */
  description: string;
  /** ID of the Insight that motivated this Proposal (for outcome correlation). */
  insightRef?: string;
  /** Signal type name used to measure the outcome (e.g. "action_failure_rate"). */
  signalRef?: string;
  /** Value of the metric before the change was applied. */
  baselineValue?: number;
  /** Target value the metric should reach after the change. */
  targetValue?: number;
  /** Unit of measurement (e.g. "ms", "%", "count"). */
  unit?: string;
}

// ── Proposal definition ──────────────────────────────────

export interface ProposalDefinition {
  id: string;
  title: string;
  description: string;

  /** Who authored the proposal */
  author: ProposalAuthor;

  /** Which capability is being changed */
  capability: string;

  /** Change level — determines approval requirements */
  changeType: ChangeType;

  /** List of changes in this proposal */
  changes: ProposalChange[];

  /** Impact analysis */
  impact: ProposalImpact;

  /** Current status */
  status: ProposalStatus;

  /** Validation results (populated after validation) */
  validationResult?: ProposalValidationResult;

  /** Timestamps */
  createdAt: Date;
  updatedAt: Date;
  validatedAt?: Date;
  lastValidationAt?: Date;
  approvedAt?: Date;
  committedAt?: Date;
  deployedAt?: Date;

  /** Approval info */
  approvedBy?: { type: string; id: string };
  rejectionReason?: string;

  /**
   * Error message captured if the `ProposalEngine.onApproved` hook (e.g. a
   * `ProposalFileWriter`) failed when persisting the approved proposal.
   * The approval status is NOT rolled back when this is set — the approval
   * decision stands, but the caller can surface this error to a human so
   * they can re-run the persistence step manually.
   */
  persistenceError?: string;

  /**
   * Optional success metric for Phase 2 effect verification (Spec 55 §7.7).
   * When set, `ProposalEffectVerifier` will measure the metric after the
   * change merges to determine whether the outcome was achieved.
   */
  successMetric?: SuccessMetric;

  /**
   * Optional pre-analysis envelope for this proposal (Spec 55 §7.3).
   *
   * Carries the evolution pipeline's per-proposal pre-analysis — dedup /
   * conflict / impact / backtest stages — so a human reviewer can see the
   * "why" (evidence, estimated impact, backtest delta, rationale) behind an
   * AI-surfaced proposal. This is READ-ONLY metadata attached when a cycle
   * proposal is persisted as a draft; it never drives submission, approval,
   * or graduation. Absent when the proposal entered the pipeline without a
   * pre-analysis (e.g. manual drafts).
   */
  analysis?: ProposalPreAnalysisResult;
}
