/**
 * Proposal type definitions
 *
 * Proposal is a change governance unit. All modifications to a Capability must go through
 * the Propose → Validate → Approve → Commit → Deploy pipeline.
 * AI can never directly modify production — every change must be proposed and validated first.
 */

import type { ActionDefinition } from "./action";
import type { EventDefinition } from "./event";
import type { RuleDefinition } from "./rule";
import type { EntityDefinition } from "./entity";
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
  | "schema"
  | "action"
  | "rule"
  | "view"
  | "state"
  | "event"
  | "flow";

export type ProposalChangeOperation = "create" | "update" | "delete";

export type ChangeDefinition =
  | EntityDefinition
  | ActionDefinition
  | RuleDefinition
  | ViewDefinition
  | StateDefinition
  | EventDefinition;

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
}
