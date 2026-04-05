/**
 * Version Registry
 *
 * Tracks API versions and compatibility for schemas, capabilities, and API contracts.
 * Central registry for version metadata across the LinchKit runtime.
 */

import { compareSemVer, isCompatible, parseSemVer } from "./compatibility";

// ── Types ──────────────────────────────────────────────────

/** Category of versioned entity */
export type VersionedEntityType = "entity" | "api" | "capability";

/** Version entry for a tracked entity */
export interface VersionEntry {
  /** Entity name (schema name, API name, capability name) */
  name: string;
  /** Entity type */
  type: VersionedEntityType;
  /** Current version (semver) */
  version: string;
  /** Minimum compatible version (consumers must be at least this version) */
  minCompatible?: string;
  /** Version at which this entity was deprecated (if applicable) */
  deprecatedAt?: string;
  /** Human-readable description of current version */
  description?: string;
  /** Timestamp of last version change */
  updatedAt: Date;
}

/** Query options for listing versions */
export interface VersionQuery {
  /** Filter by entity type */
  type?: VersionedEntityType;
  /** Filter by name prefix */
  namePrefix?: string;
  /** Include deprecated entries (default: true) */
  includeDeprecated?: boolean;
}

/** Compatibility check result */
export interface CompatibilityCheckResult {
  compatible: boolean;
  entity: string;
  required: string;
  available: string;
  reason?: string;
}

// ── Version Registry ───────────────────────────────────────

/**
 * Central registry for tracking versioned entities in the LinchKit runtime.
 *
 * Manages version metadata for schemas, API contracts, and capabilities.
 * Provides compatibility queries between consumer requirements and available versions.
 */
export class VersionRegistry {
  private entries = new Map<string, VersionEntry>();

  /** Generate a unique key for an entry */
  private key(type: VersionedEntityType, name: string): string {
    return `${type}:${name}`;
  }

  /**
   * Register or update a versioned entity.
   * If the entity already exists, its version is updated.
   */
  register(entry: Omit<VersionEntry, "updatedAt">): void {
    // Validate version format
    parseSemVer(entry.version);
    if (entry.minCompatible) {
      parseSemVer(entry.minCompatible);
    }
    if (entry.deprecatedAt) {
      parseSemVer(entry.deprecatedAt);
    }

    const k = this.key(entry.type, entry.name);
    this.entries.set(k, { ...entry, updatedAt: new Date() });
  }

  /** Get a version entry by type and name */
  get(type: VersionedEntityType, name: string): VersionEntry | null {
    return this.entries.get(this.key(type, name)) ?? null;
  }

  /** Check if a specific entity is registered */
  has(type: VersionedEntityType, name: string): boolean {
    return this.entries.has(this.key(type, name));
  }

  /** Remove a version entry */
  remove(type: VersionedEntityType, name: string): boolean {
    return this.entries.delete(this.key(type, name));
  }

  /**
   * List version entries matching a query.
   */
  list(query?: VersionQuery): VersionEntry[] {
    let results = Array.from(this.entries.values());

    if (query?.type) {
      results = results.filter((e) => e.type === query.type);
    }
    if (query?.namePrefix) {
      // biome-ignore lint/style/noNonNullAssertion: checked by truthy guard above
      results = results.filter((e) => e.name.startsWith(query.namePrefix!));
    }
    if (query?.includeDeprecated === false) {
      results = results.filter((e) => !e.deprecatedAt);
    }

    return results;
  }

  /**
   * Check if a required version is compatible with the registered version.
   * Uses semver compatibility rules.
   */
  checkCompatibility(
    type: VersionedEntityType,
    name: string,
    requiredVersion: string,
  ): CompatibilityCheckResult {
    const entry = this.get(type, name);

    if (!entry) {
      return {
        compatible: false,
        entity: `${type}:${name}`,
        required: requiredVersion,
        available: "not registered",
        reason: `Entity "${name}" of type "${type}" is not registered`,
      };
    }

    const compatible = isCompatible(requiredVersion, entry.version);

    // Also check minCompatible constraint
    if (compatible && entry.minCompatible) {
      const reqSv = parseSemVer(requiredVersion);
      const minSv = parseSemVer(entry.minCompatible);
      if (compareSemVer(reqSv, minSv) < 0) {
        return {
          compatible: false,
          entity: `${type}:${name}`,
          required: requiredVersion,
          available: entry.version,
          reason: `Required version ${requiredVersion} is below minimum compatible version ${entry.minCompatible}`,
        };
      }
    }

    return {
      compatible,
      entity: `${type}:${name}`,
      required: requiredVersion,
      available: entry.version,
      reason: compatible
        ? undefined
        : `Version ${requiredVersion} is not compatible with ${entry.version}`,
    };
  }

  /**
   * Batch compatibility check — verify multiple requirements at once.
   * Returns all results; the caller can check for any failures.
   */
  checkMultiple(
    requirements: Array<{ type: VersionedEntityType; name: string; version: string }>,
  ): CompatibilityCheckResult[] {
    return requirements.map((req) => this.checkCompatibility(req.type, req.name, req.version));
  }

  /** Get the current version string for an entity, or null if not registered */
  currentVersion(type: VersionedEntityType, name: string): string | null {
    return this.get(type, name)?.version ?? null;
  }

  /** Mark an entity as deprecated at a given version */
  deprecate(type: VersionedEntityType, name: string, atVersion: string): void {
    const entry = this.get(type, name);
    if (!entry) {
      throw new Error(`Cannot deprecate unregistered entity: ${type}:${name}`);
    }
    parseSemVer(atVersion);
    entry.deprecatedAt = atVersion;
    entry.updatedAt = new Date();
  }
}

// ── Factory ────────────────────────────────────────────────

/** Create a new VersionRegistry instance */
export function createVersionRegistry(): VersionRegistry {
  return new VersionRegistry();
}
