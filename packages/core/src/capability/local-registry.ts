/**
 * Local Capability Registry — file-based registry for capability discovery
 *
 * Manages a local `capability-registry.json` file that tracks installed
 * and published capabilities. Supports search, trust level filtering,
 * and dependency queries. Analogous to Obsidian's community-plugins.json.
 */

import type { CapabilityType } from "../types/capability";

// `TrustLevel` was moved to `types/trust.ts` to break a `types → capability`
// import cycle (see types/trust.ts). Re-exported here so existing importers of
// `@linchkit/core` (e.g. the CLI commands, search.ts) are unaffected.
export type { TrustLevel } from "../types/trust";

import type { TrustLevel } from "../types/trust";

// ── Trust levels ────────────────────────────────────────

/** System permissions allowed per trust level */
const TRUST_LEVEL_PERMISSIONS: Record<TrustLevel, string[] | "all"> = {
  official: "all",
  verified: "all",
  community: ["database.create_table", "database.create_index"],
  unverified: [],
};

/**
 * Check if a trust level allows the given system permissions.
 */
export function checkTrustPermissions(
  trustLevel: TrustLevel,
  permissions: string[],
): { allowed: boolean; denied: string[] } {
  const allowed = TRUST_LEVEL_PERMISSIONS[trustLevel];
  if (allowed === "all") return { allowed: true, denied: [] };

  const denied = permissions.filter((p) => !allowed.includes(p));
  return { allowed: denied.length === 0, denied };
}

// ── Registry entry ──────────────────────────────────────

export interface RegistryEntry {
  /** Package name (npm-style) */
  name: string;
  /** Installed version */
  version: string;
  /** Capability type */
  type: CapabilityType;
  /** Category */
  category: string;
  /** Human-readable label */
  label?: string;
  /** Description */
  description?: string;
  /** Trust level */
  trustLevel: TrustLevel;
  /** Repository URL */
  repository?: string;
  /** Author */
  author?: string;
  /** npm package name (if different from name) */
  npm?: string;
  /** Dependencies (capability names) */
  dependencies?: string[];
  /** System permissions required */
  systemPermissions?: string[];
  /** Minimum core version */
  minCoreVersion?: string;
  /** ISO date of installation/registration */
  installedAt?: string;
}

// ── Search options ──────────────────────────────────────

export interface RegistrySearchOptions {
  /** Keyword search across name, label, description */
  query?: string;
  /** Filter by type */
  type?: CapabilityType;
  /** Filter by category */
  category?: string;
  /** Filter by trust level */
  trustLevel?: TrustLevel;
  /** Only show installed capabilities */
  installed?: boolean;
}

// ── Local Registry ──────────────────────────────────────

export class LocalCapabilityRegistry {
  private entries = new Map<string, RegistryEntry>();

  constructor(initialEntries?: RegistryEntry[]) {
    if (initialEntries) {
      for (const entry of initialEntries) {
        this.entries.set(entry.name, entry);
      }
    }
  }

  /**
   * Add or update an entry in the registry.
   */
  register(entry: RegistryEntry): void {
    this.entries.set(entry.name, entry);
  }

  /**
   * Remove an entry from the registry.
   * Returns true if found and removed.
   */
  unregister(name: string): boolean {
    return this.entries.delete(name);
  }

  /**
   * Get a registry entry by name.
   */
  get(name: string): RegistryEntry | undefined {
    return this.entries.get(name);
  }

  /**
   * Check if a capability is registered.
   */
  has(name: string): boolean {
    return this.entries.has(name);
  }

  /**
   * List all entries.
   */
  list(): RegistryEntry[] {
    return Array.from(this.entries.values());
  }

  /**
   * Search entries with filters and keyword matching.
   */
  search(options: RegistrySearchOptions): RegistryEntry[] {
    let results = this.list();

    if (options.type) {
      results = results.filter((e) => e.type === options.type);
    }

    if (options.category) {
      results = results.filter((e) => e.category === options.category);
    }

    if (options.trustLevel) {
      results = results.filter((e) => e.trustLevel === options.trustLevel);
    }

    if (options.query) {
      const q = options.query.toLowerCase();
      results = results.filter(
        (e) =>
          e.name.toLowerCase().includes(q) ||
          e.label?.toLowerCase().includes(q) ||
          e.description?.toLowerCase().includes(q),
      );
    }

    return results;
  }

  /**
   * Find all capabilities that depend on the given capability.
   * Used for uninstall dependency protection.
   */
  dependentsOf(name: string): string[] {
    const result: string[] = [];
    for (const entry of this.entries.values()) {
      if (entry.dependencies?.includes(name)) {
        result.push(entry.name);
      }
    }
    return result;
  }

  /**
   * Check if uninstalling a capability would break other capabilities.
   */
  canUninstall(name: string): { safe: boolean; dependents: string[] } {
    const dependents = this.dependentsOf(name);
    return { safe: dependents.length === 0, dependents };
  }

  /** Number of registered entries */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Serialize to JSON-safe array.
   */
  toJSON(): RegistryEntry[] {
    return this.list();
  }

  /**
   * Load from a JSON array (e.g. parsed from capability-registry.json).
   */
  static fromJSON(data: unknown): LocalCapabilityRegistry {
    if (!Array.isArray(data)) {
      return new LocalCapabilityRegistry();
    }
    const entries: RegistryEntry[] = [];
    for (const item of data) {
      if (isRegistryEntry(item)) {
        entries.push(item);
      }
    }
    return new LocalCapabilityRegistry(entries);
  }
}

// ── Type guard ──────────────────────────────────────────

function isRegistryEntry(value: unknown): value is RegistryEntry {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.name === "string" &&
    typeof obj.version === "string" &&
    typeof obj.type === "string" &&
    typeof obj.category === "string" &&
    typeof obj.trustLevel === "string"
  );
}

// ── Factory ─────────────────────────────────────────────

export function createLocalRegistry(entries?: RegistryEntry[]): LocalCapabilityRegistry {
  return new LocalCapabilityRegistry(entries);
}
