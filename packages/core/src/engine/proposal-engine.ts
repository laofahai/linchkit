/**
 * Proposal Engine
 *
 * Manages the lifecycle of proposals through the governance pipeline:
 * draft → validating → validated → approved → committed → deployed (or rejected)
 *
 * Uses InMemoryStore for M0b/M1. Integrates with the validation engine for Phase 1 checks.
 *
 * NOTE: InMemoryStore returns object references, not copies. Methods that return
 * ProposalDefinition return the same object stored in the Map. This is intentional
 * for M0b performance. When moving to persistent storage (Drizzle / DB), adopt
 * copy-on-read semantics so callers cannot accidentally mutate stored state.
 */

import type { ProposalPreAnalysisResult } from "../life-system/proposal-preanalysis/types";
import { analyzeImpact } from "../ontology/impact-analysis";
import type { Logger } from "../types/logger";
import type {
  ChangeType,
  ProposalAuthor,
  ProposalChange,
  ProposalDefinition,
  ProposalImpact,
} from "../types/proposal";
import type { SemanticRelation } from "../types/semantic-relation";
import type { VersionRecord } from "../types/version";
import { type ValidationContext, validateProposal } from "./validation-engine";

// ── ID generation helper ─────────────────────────────────

function generateId(): string {
  return crypto.randomUUID();
}

// ── Create proposal options ──────────────────────────────

export interface CreateProposalOptions {
  title: string;
  description: string;
  author: ProposalAuthor;
  capability: string;
  changeType: ChangeType;
  changes: ProposalChange[];
  impact?: Partial<ProposalImpact>;
  /**
   * Optional pre-analysis envelope to attach to the created draft (Spec 55 §7.3).
   *
   * When provided, it is stored verbatim on `ProposalDefinition.analysis` so the
   * review UI can show the evidence/impact/backtest rationale behind the change.
   * Read-only metadata — it never affects validation, approval, or graduation.
   */
  analysis?: ProposalPreAnalysisResult;
}

// ── Engine options ───────────────────────────────────────

/**
 * Hook invoked after a proposal transitions from "validated" → "approved".
 *
 * Used to wire the Spec 55 §7.6 graduation step: a `ProposalFileWriter`
 * (or any other downstream persistence — Git PR, hot-reload, etc.) can be
 * attached here to materialise the approved change as Layer 0 source code.
 *
 * The hook is awaited. If it throws, the engine captures the error message
 * in `proposal.persistenceError` and continues — the approval status is
 * NOT rolled back. Persistence is treated as a separate concern from the
 * approval decision itself.
 */
export type OnApprovedHook = (proposal: ProposalDefinition) => Promise<void> | void;

/**
 * Hook invoked after a proposal transitions from "validated" → "rejected".
 *
 * Mirrors {@link OnApprovedHook}. Errors thrown by this hook are swallowed
 * and logged — the rejection status is NOT rolled back.
 */
export type OnRejectedHook = (proposal: ProposalDefinition) => Promise<void> | void;

export interface ProposalEngineOptions {
  /** Hook fired after a successful approval. See {@link OnApprovedHook}. */
  onApproved?: OnApprovedHook;
  /** Hook fired after a successful rejection. See {@link OnRejectedHook}. */
  onRejected?: OnRejectedHook;
  /** Optional logger used to surface hook failures. */
  logger?: Logger;
}

// ── Proposal Engine ──────────────────────────────────────

export class ProposalEngine {
  private proposals = new Map<string, ProposalDefinition>();
  private versions = new Map<string, VersionRecord>();
  private semanticRelations: SemanticRelation[] = [];
  private readonly onApproved?: OnApprovedHook;
  private readonly onRejectedHook?: OnRejectedHook;
  private readonly logger?: Logger;

  constructor(options: ProposalEngineOptions = {}) {
    this.onApproved = options.onApproved;
    this.onRejectedHook = options.onRejected;
    this.logger = options.logger;
  }

  /**
   * Set the semantic relation graph for cascading impact analysis.
   * Called at startup after relations are inferred.
   */
  setSemanticRelations(relations: SemanticRelation[]): void {
    this.semanticRelations = relations;
  }

  /**
   * Create a new proposal in draft status.
   */
  createProposal(options: CreateProposalOptions): ProposalDefinition {
    const now = new Date();

    // Auto-calculate affected items from changes array
    const autoSchemas = new Set<string>();
    const autoActions = new Set<string>();
    const autoRules = new Set<string>();
    for (const change of options.changes) {
      switch (change.target) {
        case "entity":
          autoSchemas.add(change.name);
          break;
        case "action":
          autoActions.add(change.name);
          break;
        case "rule":
          autoRules.add(change.name);
          break;
      }
    }

    // Compute cascading impacts from semantic relation graph (if available)
    let cascadingImpacts = options.impact?.cascadingImpacts;
    if (!cascadingImpacts && this.semanticRelations.length > 0) {
      const allAffectedEntities = [...autoSchemas];
      const cascading = allAffectedEntities.flatMap((entity) => {
        const result = analyzeImpact(entity, this.semanticRelations, { maxDepth: 3 });
        return [...result.directImpacts, ...result.indirectImpacts];
      });
      // Deduplicate by entity name
      const seen = new Set<string>();
      cascadingImpacts = cascading.filter((n) => {
        if (seen.has(n.entity)) return false;
        seen.add(n.entity);
        return true;
      });
    }

    const proposal: ProposalDefinition = {
      id: generateId(),
      title: options.title,
      description: options.description,
      author: options.author,
      capability: options.capability,
      changeType: options.changeType,
      changes: options.changes,
      impact: {
        schemasAffected: options.impact?.schemasAffected ?? [...autoSchemas],
        actionsAffected: options.impact?.actionsAffected ?? [...autoActions],
        rulesAffected: options.impact?.rulesAffected ?? [...autoRules],
        dependentsAffected: options.impact?.dependentsAffected ?? [],
        migrationRequired: options.impact?.migrationRequired ?? false,
        cascadingImpacts,
      },
      status: "draft",
      createdAt: now,
      updatedAt: now,
      // Attach the optional pre-analysis envelope so the review UI can surface
      // the "why" behind the proposal. Omitted entirely when not provided.
      ...(options.analysis ? { analysis: options.analysis } : {}),
    };

    this.proposals.set(proposal.id, proposal);
    return proposal;
  }

  /**
   * Submit a proposal for validation (draft → validating → validated/failed).
   * Runs validation and updates the proposal status based on results.
   */
  submitProposal(options: { proposalId: string; context?: ValidationContext }): ProposalDefinition {
    const { proposalId, context } = options;
    const proposal = this.getProposal(proposalId);

    if (proposal.status !== "draft") {
      throw new Error(
        `Cannot submit proposal "${proposalId}": expected status "draft", got "${proposal.status}"`,
      );
    }

    // Move to validating
    proposal.status = "validating";
    proposal.updatedAt = new Date();

    // Run validation
    const result = validateProposal({ proposal, context });

    // Update status based on result. Always preserve validationResult so callers
    // can inspect errors after a failed validation via getProposal().
    const now2 = new Date();
    proposal.validationResult = result;
    proposal.lastValidationAt = now2;
    proposal.status = result.passed ? "validated" : "draft";
    proposal.validatedAt = result.passed ? now2 : undefined;
    proposal.updatedAt = now2;

    return proposal;
  }

  /**
   * Update a draft proposal's changes, title, or description.
   * Useful for fixing validation errors and re-submitting.
   * Only allowed when status is "draft".
   */
  updateProposal(
    id: string,
    updates: { changes?: ProposalChange[]; title?: string; description?: string },
  ): ProposalDefinition {
    const proposal = this.getProposal(id);

    if (proposal.status !== "draft") {
      throw new Error(
        `Cannot update proposal "${id}": expected status "draft", got "${proposal.status}"`,
      );
    }

    if (updates.title !== undefined) {
      proposal.title = updates.title;
    }
    if (updates.description !== undefined) {
      proposal.description = updates.description;
    }
    if (updates.changes !== undefined) {
      proposal.changes = updates.changes;

      // Recalculate auto-impact
      const autoSchemas = new Set<string>();
      const autoActions = new Set<string>();
      const autoRules = new Set<string>();
      for (const change of updates.changes) {
        switch (change.target) {
          case "entity":
            autoSchemas.add(change.name);
            break;
          case "action":
            autoActions.add(change.name);
            break;
          case "rule":
            autoRules.add(change.name);
            break;
        }
      }
      proposal.impact.schemasAffected = [...autoSchemas];
      proposal.impact.actionsAffected = [...autoActions];
      proposal.impact.rulesAffected = [...autoRules];
    }

    proposal.updatedAt = new Date();
    return proposal;
  }

  /**
   * Approve a validated proposal (validated → approved).
   *
   * If an `onApproved` hook is configured on the engine, it is invoked AFTER
   * the status transition. Hook failures are captured in
   * `proposal.persistenceError` and do NOT roll back the approval — the
   * approval decision stands, persistence is a separate concern.
   */
  async approveProposal(options: {
    proposalId: string;
    approvedBy: { type: string; id: string };
  }): Promise<ProposalDefinition> {
    const { proposalId, approvedBy } = options;
    const proposal = this.getProposal(proposalId);

    if (proposal.status !== "validated") {
      throw new Error(
        `Cannot approve proposal "${proposalId}": expected status "validated", got "${proposal.status}"`,
      );
    }

    proposal.status = "approved";
    proposal.approvedBy = approvedBy;
    proposal.approvedAt = new Date();
    proposal.updatedAt = new Date();
    // Clear any stale persistence error from a previous attempt.
    proposal.persistenceError = undefined;

    if (this.onApproved) {
      try {
        await this.onApproved(proposal);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        proposal.persistenceError = message;
        this.logger?.error?.(
          `ProposalEngine.onApproved hook failed for proposal "${proposalId}": ${message}`,
          { proposalId, error: message },
        );
      }
    }

    return proposal;
  }

  /**
   * Reject a validated proposal (validated → rejected).
   *
   * If an `onRejected` hook is configured, it is invoked after the status
   * transition. Hook failures are logged and swallowed — the rejection stands.
   */
  async rejectProposal(options: {
    proposalId: string;
    reason: string;
  }): Promise<ProposalDefinition> {
    const { proposalId, reason } = options;
    const proposal = this.getProposal(proposalId);

    if (proposal.status !== "validated") {
      throw new Error(
        `Cannot reject proposal "${proposalId}": expected status "validated", got "${proposal.status}"`,
      );
    }

    proposal.status = "rejected";
    proposal.rejectionReason = reason;
    proposal.updatedAt = new Date();

    if (this.onRejectedHook) {
      try {
        await this.onRejectedHook(proposal);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger?.error?.(
          `ProposalEngine.onRejected hook failed for proposal "${proposalId}": ${message}`,
          { proposalId, error: message },
        );
      }
    }

    return proposal;
  }

  /**
   * Commit an approved proposal (approved → committed).
   * Creates a version record for the capability.
   */
  commitProposal(options: {
    proposalId: string;
    previousVersion?: string;
    changelog?: string;
    createdBy?: string;
  }): { proposal: ProposalDefinition; version: VersionRecord } {
    const { proposalId, previousVersion, changelog, createdBy } = options;
    const proposal = this.getProposal(proposalId);

    if (proposal.status !== "approved") {
      throw new Error(
        `Cannot commit proposal "${proposalId}": expected status "approved", got "${proposal.status}"`,
      );
    }

    proposal.status = "committed";
    proposal.committedAt = new Date();
    proposal.updatedAt = new Date();

    // Find latest version for this capability to avoid duplicate version numbers
    const existingVersions = this.listVersions(proposal.capability);
    // listVersions returns newest-first, so [0] is the latest
    const latestVersion = existingVersions.length > 0 ? existingVersions[0] : undefined;
    const prev = previousVersion ?? latestVersion?.version ?? "0.0.0";
    const newVersion = bumpVersion(prev, proposal.changeType);

    // Check for duplicate version number
    const duplicate = existingVersions.find((v) => v.version === newVersion);
    if (duplicate) {
      throw new Error(
        `Version "${newVersion}" already exists for capability "${proposal.capability}" (from proposal "${duplicate.proposalId}")`,
      );
    }
    const version: VersionRecord = {
      id: generateId(),
      capability: proposal.capability,
      version: newVersion,
      previousVersion: prev,
      proposalId: proposal.id,
      gitCommit: "",
      gitTag: `${proposal.capability}@${newVersion}`,
      changelog: changelog ?? proposal.description,
      migrationApplied: proposal.impact.migrationRequired,
      status: "active",
      createdAt: new Date(),
      createdBy: createdBy ?? proposal.author.id,
    };

    this.versions.set(version.id, version);

    return { proposal, version };
  }

  /**
   * Deploy a committed proposal (committed → deployed).
   */
  deployProposal(options: { proposalId: string }): ProposalDefinition {
    const { proposalId } = options;
    const proposal = this.getProposal(proposalId);

    if (proposal.status !== "committed") {
      throw new Error(
        `Cannot deploy proposal "${proposalId}": expected status "committed", got "${proposal.status}"`,
      );
    }

    proposal.status = "deployed";
    proposal.deployedAt = new Date();
    proposal.updatedAt = new Date();

    return proposal;
  }

  /**
   * Get a proposal by ID. Throws if not found.
   */
  getProposal(id: string): ProposalDefinition {
    const proposal = this.proposals.get(id);
    if (!proposal) {
      throw new Error(`Proposal "${id}" not found`);
    }
    return proposal;
  }

  /**
   * Get all proposals, optionally filtered by status or capability.
   */
  listProposals(filter?: { status?: string; capability?: string }): ProposalDefinition[] {
    let result = Array.from(this.proposals.values());
    if (filter?.status) {
      result = result.filter((p) => p.status === filter.status);
    }
    if (filter?.capability) {
      result = result.filter((p) => p.capability === filter.capability);
    }
    return result;
  }

  /**
   * Get a version record by ID.
   */
  getVersion(id: string): VersionRecord | undefined {
    return this.versions.get(id);
  }

  /**
   * Get all version records for a capability, sorted by creation time (newest first).
   */
  listVersions(capability: string): VersionRecord[] {
    return Array.from(this.versions.values())
      .filter((v) => v.capability === capability)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }
}

// ── Version bump helper ──────────────────────────────────

/**
 * Bump a semver version string based on change type.
 */
export function bumpVersion(current: string, changeType: ChangeType): string {
  const parts = current.split(".").map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    throw new Error(`Invalid semver version: "${current}"`);
  }

  const major = parts[0] as number;
  const minor = parts[1] as number;
  const patch = parts[2] as number;
  switch (changeType) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
  }
}

/**
 * Compare two semver strings. Returns negative if a < b, 0 if equal, positive if a > b.
 */
export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// ── Factory ──────────────────────────────────────────────

/** Create a new ProposalEngine instance */
export function createProposalEngine(options: ProposalEngineOptions = {}): ProposalEngine {
  return new ProposalEngine(options);
}
