/**
 * Capability Hub — discovery and dependency management
 *
 * Central registry for capability manifests. Resolves initialization order
 * via topological sort, detects circular dependencies, validates compatibility
 * between capabilities, and provides discovery APIs.
 */

import type { CapabilityType } from "../types/capability";
import type { CapabilityDependency, CapabilityManifest } from "./capability-manifest";

// ── Error types ──────────────────────────────────────────

export class CapabilityHubError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "DUPLICATE"
      | "NOT_FOUND"
      | "CIRCULAR_DEPENDENCY"
      | "UNRESOLVED_DEPENDENCY"
      | "VERSION_MISMATCH"
      | "COMPATIBILITY",
  ) {
    super(message);
    this.name = "CapabilityHubError";
  }
}

// ── Version matching ─────────────────────────────────────

/**
 * Parse a version string into a [major, minor, patch] tuple.
 *
 * Known limitation (pre-existing, intentionally not handled — YAGNI): leading
 * non-numeric characters are stripped and a pre-release tag is flattened to its
 * release version, so "1.2.3-alpha" parses as [1, 2, 3]. Strict-semver
 * pre-release ordering is not implemented.
 */
function parseVer(v: string): [number, number, number] {
  const parts = v.replace(/^[^0-9]*/, "").split(".");
  return [
    Number.parseInt(parts[0] ?? "0", 10),
    Number.parseInt(parts[1] ?? "0", 10),
    Number.parseInt(parts[2] ?? "0", 10),
  ];
}

/**
 * Collapse a [major, minor, patch] tuple into a single comparable number.
 *
 * Known limitation (pre-existing, intentionally not handled — YAGNI): each
 * segment is weighted by 1000, so a segment >= 1000 overflows into the next
 * segment (e.g. "0.1000.0" mis-compares against "1.0.0").
 */
function toNum([major, minor, patch]: [number, number, number]): number {
  return major * 1_000_000 + minor * 1_000 + patch;
}

/**
 * Evaluate a single comparator (no internal whitespace) against a version.
 * Supports ^, ~, >=, <=, >, <, =, the `*` wildcard, and bare versions.
 */
function satisfiesComparator(version: string, comparator: string): boolean {
  const [vMajor, vMinor, vPatch] = parseVer(version);
  const vNum = toNum([vMajor, vMinor, vPatch]);
  const trimmed = comparator.trim();

  // Wildcard: "*" (and a bare empty token left after stripping an operator)
  // matches any version.
  if (trimmed === "" || trimmed === "*") {
    return true;
  }

  if (trimmed.startsWith("^")) {
    const [rMajor, rMinor, rPatch] = parseVer(trimmed);
    const rNum = toNum([rMajor, rMinor, rPatch]);
    // npm semver: ^0.0.x locks to exact, ^0.y.z locks to minor, ^x.y.z locks to major
    if (rMajor === 0 && rMinor === 0) {
      return vNum === rNum; // ^0.0.x => exact match
    }
    const ceilNum =
      rMajor === 0
        ? rMajor * 1_000_000 + (rMinor + 1) * 1_000 // ^0.y.z => <0.(y+1).0
        : (rMajor + 1) * 1_000_000; // ^x.y.z => <(x+1).0.0
    return vNum >= rNum && vNum < ceilNum;
  }

  if (trimmed.startsWith("~")) {
    const [rMajor, rMinor, rPatch] = parseVer(trimmed);
    const rNum = toNum([rMajor, rMinor, rPatch]);
    const ceilNum = rMajor * 1_000_000 + (rMinor + 1) * 1_000;
    return vNum >= rNum && vNum < ceilNum;
  }

  // Note: ">=" / "<=" must be checked before bare ">" / "<".
  if (trimmed.startsWith(">=")) {
    return vNum >= toNum(parseVer(trimmed));
  }
  if (trimmed.startsWith("<=")) {
    return vNum <= toNum(parseVer(trimmed));
  }
  if (trimmed.startsWith(">")) {
    return vNum > toNum(parseVer(trimmed));
  }
  if (trimmed.startsWith("<")) {
    return vNum < toNum(parseVer(trimmed));
  }

  // Exact match (with or without leading "=")
  const [rMajor, rMinor, rPatch] = parseVer(trimmed);
  return vMajor === rMajor && vMinor === rMinor && vPatch === rPatch;
}

/**
 * Semver range check supporting ^, ~, >=, <=, >, <, =, the `*` wildcard, bare
 * versions, and whitespace-joined compound (AND) ranges.
 *
 * Examples:
 * - "^1.2.3" => >=1.2.3 and <2.0.0 (caret)
 * - "~1.2.3" => >=1.2.3 and <1.3.0 (tilde)
 * - ">=1.2.3" => greater or equal
 * - ">= 1.2.3" => greater or equal (whitespace after the operator is allowed)
 * - "1.2.3" or "=1.2.3" => exact match
 * - "*" => matches any version
 * - ">=0.2.0 <0.4.0" => compound: AND of each comparator
 * - ">= 0.2.0 < 0.4.0" => compound, with space after each operator
 *
 * NOTE: Only AND (whitespace-joined) compound ranges are supported. OR ranges
 * ("||") are NOT supported and are treated as a single AND group (and will
 * therefore never match).
 *
 * Known limitations (pre-existing, intentionally not handled — YAGNI):
 * - `toNum` weights each version segment by 1000, so a segment >= 1000 overflows
 *   into the next segment (e.g. "0.1000.0" mis-compares against "1.0.0").
 * - Pre-release tags are flattened to the release version ("1.2.3-alpha" =>
 *   "1.2.3") by `parseVer`; strict-semver pre-release ordering is not implemented.
 */
export function satisfiesVersionRange(version: string, range: string): boolean {
  // Collapse whitespace that immediately follows a comparator operator so that
  // ">= 0.2.0" becomes ">=0.2.0" and each comparator stays attached to its
  // version. THEN split the remaining whitespace into separate AND comparators.
  const normalized = range.trim().replace(/([<>=~^]+)\s+/g, "$1");
  const comparators = normalized.split(/\s+/).filter(Boolean);
  if (comparators.length === 0) return false;
  return comparators.every((comparator) => satisfiesComparator(version, comparator));
}

// ── Validation result ────────────────────────────────────

export interface CompatibilityIssue {
  type: "missing_dependency" | "version_mismatch" | "missing_service" | "missing_schema";
  capability: string;
  detail: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: CompatibilityIssue[];
}

// ── Search / filter options ──────────────────────────────

export interface CapabilitySearchOptions {
  /** Filter by capability type */
  type?: CapabilityType;
  /** Filter by category */
  category?: string;
  /** Keyword search across name, label, description */
  query?: string;
}

// ── CapabilityHub ────────────────────────────────────────

export class CapabilityHub {
  private manifests = new Map<string, CapabilityManifest>();

  /**
   * Register a capability manifest.
   * Throws if a capability with the same name is already registered.
   */
  register(manifest: CapabilityManifest): void {
    if (this.manifests.has(manifest.name)) {
      throw new CapabilityHubError(
        `Capability "${manifest.name}" is already registered`,
        "DUPLICATE",
      );
    }
    this.manifests.set(manifest.name, manifest);
  }

  /**
   * Unregister a capability by name.
   * Returns true if found and removed, false otherwise.
   */
  unregister(name: string): boolean {
    return this.manifests.delete(name);
  }

  /**
   * Get a manifest by name. Returns undefined if not found.
   */
  get(name: string): CapabilityManifest | undefined {
    return this.manifests.get(name);
  }

  /**
   * Check if a capability is registered.
   */
  has(name: string): boolean {
    return this.manifests.has(name);
  }

  /**
   * List all registered manifests.
   */
  list(): CapabilityManifest[] {
    return Array.from(this.manifests.values());
  }

  /**
   * Search / filter capabilities.
   */
  search(options: CapabilitySearchOptions): CapabilityManifest[] {
    let results = this.list();

    if (options.type) {
      results = results.filter((m) => m.type === options.type);
    }

    if (options.category) {
      results = results.filter((m) => m.category === options.category);
    }

    if (options.query) {
      const q = options.query.toLowerCase();
      results = results.filter(
        (m) =>
          m.name.toLowerCase().includes(q) ||
          m.label?.toLowerCase().includes(q) ||
          m.description?.toLowerCase().includes(q),
      );
    }

    return results;
  }

  /**
   * Resolve the dependency initialization order via topological sort (Kahn's algorithm).
   * Returns capability names in the order they should be initialized.
   *
   * Throws CapabilityHubError if:
   * - A required dependency is not registered (code: UNRESOLVED_DEPENDENCY)
   * - A circular dependency is detected (code: CIRCULAR_DEPENDENCY)
   * - A version range is not satisfied (code: VERSION_MISMATCH)
   */
  resolveDependencyOrder(): string[] {
    // Build adjacency + in-degree
    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>(); // dep -> dependants

    for (const name of this.manifests.keys()) {
      inDegree.set(name, 0);
      adjacency.set(name, []);
    }

    for (const manifest of this.manifests.values()) {
      const deps = manifest.dependencies ?? [];
      for (const dep of deps) {
        // Skip optional deps that aren't registered — no edge needed
        if (dep.optional && !this.manifests.has(dep.name)) {
          continue;
        }

        this.validateDependency(manifest.name, dep);

        // Edge: dep.name -> manifest.name (dep must init before manifest)
        inDegree.set(manifest.name, (inDegree.get(manifest.name) ?? 0) + 1);
        const adj = adjacency.get(dep.name);
        if (adj) {
          adj.push(manifest.name);
        }
      }
    }

    // Kahn's algorithm
    const queue: string[] = [];
    for (const [name, degree] of inDegree) {
      if (degree === 0) {
        queue.push(name);
      }
    }

    const sorted: string[] = [];
    while (queue.length > 0) {
      // Sort queue for deterministic output
      queue.sort();
      // biome-ignore lint/style/noNonNullAssertion: queue.length > 0 guaranteed
      const current = queue.shift()!;
      sorted.push(current);

      for (const dependent of adjacency.get(current) ?? []) {
        const newDeg = (inDegree.get(dependent) ?? 1) - 1;
        inDegree.set(dependent, newDeg);
        if (newDeg === 0) {
          queue.push(dependent);
        }
      }
    }

    if (sorted.length !== this.manifests.size) {
      // Find the cycle participants
      const inCycle = Array.from(this.manifests.keys()).filter((n) => !sorted.includes(n));
      throw new CapabilityHubError(
        `Circular dependency detected among: ${inCycle.join(", ")}`,
        "CIRCULAR_DEPENDENCY",
      );
    }

    return sorted;
  }

  /**
   * Validate compatibility of all registered capabilities.
   * Checks dependency availability, version ranges, and provides/requires matching.
   */
  validate(): ValidationResult {
    const issues: CompatibilityIssue[] = [];

    // Collect all provided services and schemas
    const providedServices = new Set<string>();
    const providedSchemas = new Set<string>();

    for (const manifest of this.manifests.values()) {
      if (manifest.provides?.services) {
        for (const s of manifest.provides.services) {
          providedServices.add(s);
        }
      }
      if (manifest.provides?.schemas) {
        for (const s of manifest.provides.schemas) {
          providedSchemas.add(s);
        }
      }
    }

    for (const manifest of this.manifests.values()) {
      // Check dependencies
      for (const dep of manifest.dependencies ?? []) {
        const target = this.manifests.get(dep.name);
        if (!target) {
          if (!dep.optional) {
            issues.push({
              type: "missing_dependency",
              capability: manifest.name,
              detail: `Required dependency "${dep.name}" is not registered`,
            });
          }
          continue;
        }
        if (dep.versionRange && !satisfiesVersionRange(target.version, dep.versionRange)) {
          issues.push({
            type: "version_mismatch",
            capability: manifest.name,
            detail: `Dependency "${dep.name}" version ${target.version} does not satisfy range "${dep.versionRange}"`,
          });
        }
      }

      // Check required services
      if (manifest.requires?.services) {
        for (const service of manifest.requires.services) {
          if (!providedServices.has(service)) {
            issues.push({
              type: "missing_service",
              capability: manifest.name,
              detail: `Required service "${service}" is not provided by any capability`,
            });
          }
        }
      }

      // Check required schemas
      if (manifest.requires?.schemas) {
        for (const schema of manifest.requires.schemas) {
          if (!providedSchemas.has(schema)) {
            issues.push({
              type: "missing_schema",
              capability: manifest.name,
              detail: `Required schema "${schema}" is not provided by any capability`,
            });
          }
        }
      }
    }

    return { valid: issues.length === 0, issues };
  }

  /**
   * Get the dependency graph as an adjacency list.
   * Returns Map<capabilityName, dependencyNames[]>.
   */
  dependencyGraph(): Map<string, string[]> {
    const graph = new Map<string, string[]>();
    for (const manifest of this.manifests.values()) {
      graph.set(
        manifest.name,
        (manifest.dependencies ?? []).map((d) => d.name),
      );
    }
    return graph;
  }

  /**
   * Get all capabilities that depend on a given capability (reverse lookup).
   */
  dependentsOf(name: string): string[] {
    const result: string[] = [];
    for (const manifest of this.manifests.values()) {
      if ((manifest.dependencies ?? []).some((d) => d.name === name)) {
        result.push(manifest.name);
      }
    }
    return result;
  }

  /** Number of registered capabilities */
  get size(): number {
    return this.manifests.size;
  }

  /**
   * Serialize to JSON-safe array (for API responses / MCP tools).
   */
  toJSON(): CapabilityManifest[] {
    return this.list();
  }

  // ── Private helpers ──────────────────────────────────────

  private validateDependency(capName: string, dep: CapabilityDependency): void {
    const target = this.manifests.get(dep.name);

    if (!target) {
      if (dep.optional) return;
      throw new CapabilityHubError(
        `Capability "${capName}" depends on "${dep.name}" which is not registered`,
        "UNRESOLVED_DEPENDENCY",
      );
    }

    if (dep.versionRange && !satisfiesVersionRange(target.version, dep.versionRange)) {
      throw new CapabilityHubError(
        `Capability "${capName}" requires "${dep.name}" version ${dep.versionRange}, but found ${target.version}`,
        "VERSION_MISMATCH",
      );
    }
  }
}

// ── Factory ──────────────────────────────────────────────

export function createCapabilityHub(): CapabilityHub {
  return new CapabilityHub();
}
