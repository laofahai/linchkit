/**
 * Install command — pure business logic extracted from install.ts so it can
 * be imported and tested without pulling in the citty CLI framework.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { CapabilityMetadata } from "@linchkit/core";
import { validateCapabilityMetadata } from "@linchkit/core";

/**
 * Resolve the path to a package's capability.json.
 * Handles both npm packages (node_modules/<name>) and local paths.
 */
export function resolveCapabilityJsonPath(packageName: string): string {
  if (packageName.startsWith(".") || isAbsolute(packageName)) {
    return resolve(process.cwd(), packageName, "capability.json");
  }
  return resolve(process.cwd(), "node_modules", packageName, "capability.json");
}

/**
 * Load and validate capability metadata from a capability.json path.
 * Returns null if the file does not exist or is not a valid capability.
 */
export function loadCapabilityMetadata(capJsonPath: string): CapabilityMetadata | null {
  if (!existsSync(capJsonPath)) return null;
  try {
    const content = readFileSync(capJsonPath, "utf-8");
    const raw = JSON.parse(content);
    const result = validateCapabilityMetadata(raw);
    if (result.success) return result.data;
    return null;
  } catch {
    return null;
  }
}

/**
 * Detect cycles in the dependency graph using DFS.
 * Returns the cycle path if one is found, or null if no cycle.
 */
export function detectDependencyCycle(
  packageName: string,
  getDeps: (name: string) => string[],
): string[] | null {
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const path: string[] = [];

  function dfs(node: string): string[] | null {
    if (inStack.has(node)) {
      const cycleStart = path.indexOf(node);
      return [...path.slice(cycleStart), node];
    }
    if (visited.has(node)) return null;

    visited.add(node);
    inStack.add(node);
    path.push(node);

    const deps = getDeps(node);
    for (const dep of deps) {
      const cycle = dfs(dep);
      if (cycle) return cycle;
    }

    path.pop();
    inStack.delete(node);
    return null;
  }

  return dfs(packageName);
}

/**
 * Validate type compatibility between capabilities.
 * Rules:
 * - Adapter capabilities cannot depend on other adapter capabilities
 * - Bridge capabilities must depend on at least one standard capability (warning only)
 */
export function validateTypeCompatibility(
  metadata: CapabilityMetadata,
  getDepMetadata: (name: string) => CapabilityMetadata | null,
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!metadata.dependencies || metadata.dependencies.length === 0) {
    return { errors, warnings };
  }

  const depCache = new Map<string, CapabilityMetadata | null>();
  const getDepMetaCached = (name: string): CapabilityMetadata | null => {
    if (!depCache.has(name)) {
      depCache.set(name, getDepMetadata(name));
    }
    return depCache.get(name) ?? null;
  };

  for (const depName of metadata.dependencies) {
    const depMeta = getDepMetaCached(depName);
    if (!depMeta) continue;

    if (metadata.type === "adapter" && depMeta.type === "adapter") {
      errors.push(
        `Adapter capability "${metadata.name}" cannot depend on adapter "${depMeta.name}". ` +
          `Adapters should only depend on standard or bridge capabilities.`,
      );
    }
  }

  if (metadata.type === "bridge") {
    const hasStandardDep = metadata.dependencies.some((depName) => {
      const depMeta = getDepMetaCached(depName);
      return depMeta?.type === "standard";
    });
    if (!hasStandardDep && metadata.dependencies.length > 0) {
      warnings.push(
        `Bridge capability "${metadata.name}" does not depend on any standard capability. ` +
          `Bridges typically connect two or more standard capabilities.`,
      );
    }
  }

  return { errors, warnings };
}

// Re-export inferTrustLevel from @linchkit/core — single source of truth
export { inferTrustLevel } from "@linchkit/core";
