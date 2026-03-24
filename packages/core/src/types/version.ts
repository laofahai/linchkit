/**
 * Version record type definitions
 *
 * Each Capability has independent versioning using semver.
 * Version records track the history of releases and rollbacks.
 */

// ── Version status ──────────────────────────────────────

export type VersionStatus = "active" | "rolled_back";

// ── Version record ──────────────────────────────────────

export interface VersionRecord {
  id: string;

  /** Which capability this version belongs to */
  capability: string;

  /** Semver version string (e.g. "1.2.0") */
  version: string;

  /** Previous version string */
  previousVersion: string;

  /** The proposal that created this version */
  proposalId: string;

  /** Git commit hash (empty string when not yet committed to git) */
  gitCommit: string;

  /** Git tag (e.g. "purchase_management@1.2.0") */
  gitTag: string;

  /** Human-readable changelog */
  changelog: string;

  /** Whether a DB migration was applied */
  migrationApplied: boolean;

  /** Current status */
  status: VersionStatus;

  /** Timestamps */
  createdAt: Date;
  createdBy: string;

  /** Rollback info */
  rolledBackAt?: Date;
  rolledBackBy?: { type: string; id: string };
  rolledBackReason?: string;
}
