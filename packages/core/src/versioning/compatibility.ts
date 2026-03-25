/**
 * Version compatibility checking
 *
 * Semver-based compatibility analysis and schema breaking-change detection.
 * Implements the release compatibility protocol from spec 38.
 */

import type { FieldDefinition, SchemaDefinition } from "../types/schema";

// ── Types ──────────────────────────────────────────────────

/** Release type classification per spec 38 §3.1 */
export type ReleaseType = "safe" | "expand" | "contract" | "breaking";

/** Rollback mode classification per spec 38 §6.1 */
export type RollbackMode = "traffic_only" | "version_only" | "manual";

/** A single breaking change detected between schema versions */
export interface BreakingChange {
  /** Type of change */
  type: "field_removed" | "field_type_changed" | "field_required_added" | "field_semantic_changed";
  /** Affected field name */
  field: string;
  /** Human-readable description */
  description: string;
  /** Release type this change implies */
  releaseType: ReleaseType;
}

/** Tenant override impact entry per spec 38 §9 */
export interface TenantOverrideImpact {
  tenantId: string;
  target: string;
  status: "valid" | "needs_migration" | "invalid";
}

/** Full release compatibility result per spec 38 §9 */
export interface ReleaseCompatibilityResult {
  releaseType: ReleaseType;
  oldVersionCanRead: boolean;
  oldVersionCanWrite: boolean;
  rollbackMode: RollbackMode;
  requiresBackfill: boolean;
  requiresDualWrite: boolean;
  tenantOverrideImpact: TenantOverrideImpact[];
  blockers: string[];
}

/** Parsed semver version */
export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

// ── Semver parsing ─────────────────────────────────────────

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/;

/** Parse a semver string into components. Throws on invalid format. */
export function parseSemVer(version: string): SemVer {
  const match = SEMVER_RE.exec(version);
  if (!match) {
    throw new Error(`Invalid semver: "${version}"`);
  }
  // biome-ignore lint/style/noNonNullAssertion: capture groups guaranteed by regex match
  const major = Number.parseInt(match[1]!, 10);
  // biome-ignore lint/style/noNonNullAssertion: capture groups guaranteed by regex match
  const minor = Number.parseInt(match[2]!, 10);
  // biome-ignore lint/style/noNonNullAssertion: capture groups guaranteed by regex match
  const patch = Number.parseInt(match[3]!, 10);
  return { major, minor, patch, prerelease: match[4] };
}

/** Format a SemVer back to string */
export function formatSemVer(v: SemVer): string {
  const base = `${v.major}.${v.minor}.${v.patch}`;
  return v.prerelease ? `${base}-${v.prerelease}` : base;
}

/**
 * Compare two semver versions. Returns:
 * - negative if a < b
 * - 0 if a === b
 * - positive if a > b
 */
export function compareSemVer(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  // Both have no prerelease = equal; prerelease < release
  if (!a.prerelease && !b.prerelease) return 0;
  if (a.prerelease && !b.prerelease) return -1;
  if (!a.prerelease && b.prerelease) return 1;
  return (a.prerelease ?? "").localeCompare(b.prerelease ?? "");
}

// ── Compatibility checking ─────────────────────────────────

/**
 * Check if `available` version is compatible with `required` version.
 *
 * Rules:
 * - Same major version required
 * - Available minor must be >= required minor
 * - If minor matches, available patch must be >= required patch
 * - Pre-0.x: minor bumps are treated as breaking (0.x semver convention)
 */
export function isCompatible(required: string, available: string): boolean {
  const req = parseSemVer(required);
  const avail = parseSemVer(available);

  // Major must match
  if (req.major !== avail.major) return false;

  // Pre-1.0: minor version changes are breaking
  if (req.major === 0) {
    if (req.minor !== avail.minor) return false;
    return avail.patch >= req.patch;
  }

  // Post-1.0: minor bumps are backward-compatible
  if (avail.minor < req.minor) return false;
  if (avail.minor > req.minor) return true;
  return avail.patch >= req.patch;
}

// ── Schema change detection ────────────────────────────────

/**
 * Detect breaking changes between two schema versions.
 *
 * Classifies changes per spec 38 §3.2:
 * - Field removal → contract
 * - Field type change → breaking
 * - New required field (no default) → contract
 * - New nullable/defaulted field → expand (not breaking, not returned)
 */
export function getBreakingChanges(
  oldSchema: SchemaDefinition,
  newSchema: SchemaDefinition,
): BreakingChange[] {
  const changes: BreakingChange[] = [];
  const oldFields = oldSchema.fields;
  const newFields = newSchema.fields;

  // Check removed fields
  for (const fieldName of Object.keys(oldFields)) {
    if (!(fieldName in newFields)) {
      changes.push({
        type: "field_removed",
        field: fieldName,
        description: `Field "${fieldName}" was removed`,
        releaseType: "contract",
      });
    }
  }

  // Check type changes and new required constraints
  for (const [fieldName, newField] of Object.entries(newFields)) {
    const oldField = oldFields[fieldName] as FieldDefinition | undefined;

    if (oldField) {
      // Type changed
      if (oldField.type !== newField.type) {
        changes.push({
          type: "field_type_changed",
          field: fieldName,
          description: `Field "${fieldName}" type changed from "${oldField.type}" to "${newField.type}"`,
          releaseType: "breaking",
        });
      }
    } else {
      // New field — only breaking if required without default
      if (newField.required && newField.default === undefined) {
        changes.push({
          type: "field_required_added",
          field: fieldName,
          description: `New required field "${fieldName}" without default value`,
          releaseType: "contract",
        });
      }
    }
  }

  return changes;
}

/**
 * Classify the release type based on schema changes.
 * Returns the most severe classification found.
 */
export function classifyRelease(
  oldSchema: SchemaDefinition,
  newSchema: SchemaDefinition,
): ReleaseType {
  const changes = getBreakingChanges(oldSchema, newSchema);

  if (changes.length === 0) {
    // Check if new fields were added (expand) or nothing changed (safe)
    const oldKeys = new Set(Object.keys(oldSchema.fields));
    const newKeys = Object.keys(newSchema.fields);
    const hasNewFields = newKeys.some((k) => !oldKeys.has(k));
    return hasNewFields ? "expand" : "safe";
  }

  // Return the most severe classification
  if (changes.some((c) => c.releaseType === "breaking")) return "breaking";
  if (changes.some((c) => c.releaseType === "contract")) return "contract";
  return "expand";
}

/**
 * Generate a full ReleaseCompatibilityResult per spec 38 §9.
 */
export function analyzeCompatibility(
  oldSchema: SchemaDefinition,
  newSchema: SchemaDefinition,
  tenantOverrides?: TenantOverrideImpact[],
): ReleaseCompatibilityResult {
  const releaseType = classifyRelease(oldSchema, newSchema);
  const changes = getBreakingChanges(oldSchema, newSchema);
  const overrides = tenantOverrides ?? [];

  const hasFieldRemovals = changes.some((c) => c.type === "field_removed");
  const hasTypeChanges = changes.some((c) => c.type === "field_type_changed");
  const hasNewRequired = changes.some((c) => c.type === "field_required_added");

  const oldVersionCanRead = !hasTypeChanges;
  const oldVersionCanWrite = !hasTypeChanges && !hasNewRequired;

  // Determine rollback mode
  let rollbackMode: RollbackMode;
  if (releaseType === "safe" || releaseType === "expand") {
    rollbackMode = "traffic_only";
  } else if (releaseType === "contract") {
    rollbackMode = "version_only";
  } else {
    rollbackMode = "manual";
  }

  // Determine if backfill or dual-write is needed
  const requiresBackfill = hasNewRequired;
  const requiresDualWrite = hasFieldRemovals && releaseType !== "breaking";

  // Build blockers
  const blockers: string[] = [];
  if (releaseType === "breaking") {
    blockers.push("Breaking changes detected — cannot deploy in single blue-green release");
  }
  if (!oldVersionCanRead) {
    blockers.push("Old version cannot read data after migration");
  }
  if (!oldVersionCanWrite && releaseType !== "safe") {
    blockers.push("Old version cannot write data during switch window");
  }
  for (const ov of overrides) {
    if (ov.status === "invalid") {
      blockers.push(`Tenant override invalid: tenant=${ov.tenantId} target=${ov.target}`);
    }
  }

  return {
    releaseType,
    oldVersionCanRead,
    oldVersionCanWrite,
    rollbackMode,
    requiresBackfill,
    requiresDualWrite,
    tenantOverrideImpact: overrides,
    blockers,
  };
}
