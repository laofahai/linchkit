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

import type {
  ChangeType,
  ProposalAuthor,
  ProposalChange,
  ProposalDefinition,
  ProposalImpact,
} from "../types/proposal";
import type { VersionRecord } from "../types/version";
import { type ValidationContext, validateProposal } from "./validation-engine";

// ── ID generation helper ─────────────────────────────────

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
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
}

// ── Proposal Engine ──────────────────────────────────────

export class ProposalEngine {
  private proposals = new Map<string, ProposalDefinition>();
  private versions = new Map<string, VersionRecord>();

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
      },
      status: "draft",
      createdAt: now,
      updatedAt: now,
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
   */
  approveProposal(options: {
    proposalId: string;
    approvedBy: { type: string; id: string };
  }): ProposalDefinition {
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

    return proposal;
  }

  /**
   * Reject a validated proposal (validated → rejected).
   */
  rejectProposal(options: { proposalId: string; reason: string }): ProposalDefinition {
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
export function createProposalEngine(): ProposalEngine {
  return new ProposalEngine();
}
