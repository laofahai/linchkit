/**
 * Proposal type definitions
 *
 * Proposal is a change governance unit. All modifications to a Capability must go through
 * the Propose → Validate → Approve → Commit → Deploy pipeline.
 * AI can never directly modify production — every change must be proposed and validated first.
 */

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
  | "overlay";

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
}
