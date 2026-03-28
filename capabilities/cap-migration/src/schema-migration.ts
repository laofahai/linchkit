/**
 * Schema migration helpers
 *
 * Provides version upgrade/downgrade transform definitions and execution.
 * Supports the expand → migrate → contract three-phase protocol (spec 38 §4.3).
 */

import { compareSemVer, parseSemVer } from "./compatibility";

// ── Types ──────────────────────────────────────────────────

/** Transform function that converts data between schema versions */
export type MigrationTransform = (data: Record<string, unknown>) => Record<string, unknown>;

/** A single migration step between two versions of a schema */
export interface SchemaMigration {
  /** Schema this migration applies to */
  schemaName: string;
  /** Source version (semver) */
  fromVersion: string;
  /** Target version (semver) */
  toVersion: string;
  /** Forward transform (upgrade) */
  up: MigrationTransform;
  /** Reverse transform (downgrade). Optional — may not be safe in production (spec 38 §6.3). */
  down?: MigrationTransform;
  /** Description of what this migration does */
  description?: string;
}

/** Result of applying a migration chain */
export interface MigrationResult {
  /** Transformed data */
  data: Record<string, unknown>;
  /** Versions traversed in order */
  path: string[];
  /** Number of migration steps applied */
  stepsApplied: number;
}

// ── Migration Registry ─────────────────────────────────────

/**
 * Registry that holds schema migrations and can resolve migration paths.
 */
export class MigrationRegistry {
  /** Map of schemaName → migrations indexed by "fromVersion→toVersion" */
  private migrations = new Map<string, Map<string, SchemaMigration>>();

  /** Register a migration */
  register(migration: SchemaMigration): void {
    const { schemaName, fromVersion, toVersion } = migration;
    // Validate semver
    parseSemVer(fromVersion);
    parseSemVer(toVersion);

    if (!this.migrations.has(schemaName)) {
      this.migrations.set(schemaName, new Map());
    }

    const key = `${fromVersion}->${toVersion}`;
    // biome-ignore lint/style/noNonNullAssertion: guaranteed to exist after set above
    const schemaMap = this.migrations.get(schemaName)!;

    if (schemaMap.has(key)) {
      throw new Error(
        `Migration already registered for "${schemaName}" from ${fromVersion} to ${toVersion}`,
      );
    }

    schemaMap.set(key, migration);
  }

  /** Get a direct migration between two versions (if registered) */
  get(schemaName: string, fromVersion: string, toVersion: string): SchemaMigration | null {
    const schemaMap = this.migrations.get(schemaName);
    if (!schemaMap) return null;
    return schemaMap.get(`${fromVersion}->${toVersion}`) ?? null;
  }

  /** List all migrations for a schema */
  list(schemaName: string): SchemaMigration[] {
    const schemaMap = this.migrations.get(schemaName);
    if (!schemaMap) return [];
    return Array.from(schemaMap.values());
  }

  /**
   * Find a migration path from one version to another using BFS.
   * Returns ordered list of version strings forming the path, or null if no path exists.
   */
  findPath(schemaName: string, fromVersion: string, toVersion: string): string[] | null {
    if (fromVersion === toVersion) return [fromVersion];

    const schemaMap = this.migrations.get(schemaName);
    if (!schemaMap) return null;

    const fromSv = parseSemVer(fromVersion);
    const toSv = parseSemVer(toVersion);
    const isUpgrade = compareSemVer(fromSv, toSv) < 0;

    // Build adjacency: version → next version
    const adjacency = new Map<string, string[]>();
    for (const migration of schemaMap.values()) {
      if (isUpgrade) {
        // For upgrades, traverse forward
        const nexts = adjacency.get(migration.fromVersion) ?? [];
        nexts.push(migration.toVersion);
        adjacency.set(migration.fromVersion, nexts);
      } else {
        // For downgrades, traverse reverse if down function exists
        if (migration.down) {
          const nexts = adjacency.get(migration.toVersion) ?? [];
          nexts.push(migration.fromVersion);
          adjacency.set(migration.toVersion, nexts);
        }
      }
    }

    // BFS
    const visited = new Set<string>();
    const queue: Array<{ version: string; path: string[] }> = [
      { version: fromVersion, path: [fromVersion] },
    ];
    visited.add(fromVersion);

    while (queue.length > 0) {
      // biome-ignore lint/style/noNonNullAssertion: length checked in while condition
      const current = queue.shift()!;
      const neighbors = adjacency.get(current.version) ?? [];

      for (const next of neighbors) {
        if (next === toVersion) {
          return [...current.path, next];
        }
        if (!visited.has(next)) {
          visited.add(next);
          queue.push({ version: next, path: [...current.path, next] });
        }
      }
    }

    return null;
  }
}

// ── Migration execution ────────────────────────────────────

/**
 * Apply migrations to transform data from one schema version to another.
 *
 * Finds the shortest migration path and applies each step's transform sequentially.
 * Throws if no migration path exists.
 */
export function applyMigration(
  registry: MigrationRegistry,
  schemaName: string,
  data: Record<string, unknown>,
  fromVersion: string,
  toVersion: string,
): MigrationResult {
  if (fromVersion === toVersion) {
    return { data: { ...data }, path: [fromVersion], stepsApplied: 0 };
  }

  const path = registry.findPath(schemaName, fromVersion, toVersion);
  if (!path) {
    throw new Error(
      `No migration path found for "${schemaName}" from ${fromVersion} to ${toVersion}`,
    );
  }

  const fromSv = parseSemVer(fromVersion);
  const toSv = parseSemVer(toVersion);
  const isUpgrade = compareSemVer(fromSv, toSv) < 0;

  let current = { ...data };
  let stepsApplied = 0;

  for (let i = 0; i < path.length - 1; i++) {
    const stepFrom = path[i] as string;
    const stepTo = path[i + 1] as string;

    if (isUpgrade) {
      const migration = registry.get(schemaName, stepFrom, stepTo);
      if (!migration) {
        throw new Error(`Migration step missing for "${schemaName}" from ${stepFrom} to ${stepTo}`);
      }
      current = migration.up(current);
    } else {
      // Downgrade: the registered migration is toVersion→fromVersion, use its down fn
      const migration = registry.get(schemaName, stepTo, stepFrom);
      if (!migration?.down) {
        throw new Error(
          `Downgrade migration missing for "${schemaName}" from ${stepFrom} to ${stepTo}`,
        );
      }
      current = migration.down(current);
    }
    stepsApplied++;
  }

  return { data: current, path, stepsApplied };
}

/**
 * Validate that a complete migration path exists between two versions.
 * Returns true if the path exists and all required transforms are available.
 */
export function validateUpgrade(
  registry: MigrationRegistry,
  schemaName: string,
  fromVersion: string,
  toVersion: string,
): { valid: boolean; path: string[] | null; error?: string } {
  const path = registry.findPath(schemaName, fromVersion, toVersion);

  if (!path) {
    return {
      valid: false,
      path: null,
      error: `No migration path from ${fromVersion} to ${toVersion}`,
    };
  }

  const fromSv = parseSemVer(fromVersion);
  const toSv = parseSemVer(toVersion);
  const isUpgrade = compareSemVer(fromSv, toSv) < 0;

  // Verify each step has the required transform
  for (let i = 0; i < path.length - 1; i++) {
    const stepFrom = path[i] as string;
    const stepTo = path[i + 1] as string;

    if (isUpgrade) {
      const migration = registry.get(schemaName, stepFrom, stepTo);
      if (!migration) {
        return {
          valid: false,
          path,
          error: `Missing migration step from ${stepFrom} to ${stepTo}`,
        };
      }
    } else {
      const migration = registry.get(schemaName, stepTo, stepFrom);
      if (!migration?.down) {
        return {
          valid: false,
          path,
          error: `Missing downgrade transform from ${stepFrom} to ${stepTo}`,
        };
      }
    }
  }

  return { valid: true, path };
}
