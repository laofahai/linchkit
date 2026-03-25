/**
 * linch install <package-name> — Install a capability package and validate its metadata.
 *
 * Runs `bun add`, then locates and validates the package's capability.json
 * using the CapabilityMetadata schema from @linchkit/core.
 *
 * Features:
 * - Validates capability.json metadata
 * - Checks dependency DAG for cycles
 * - Validates capability type compatibility (adapters cannot depend on adapters)
 * - --dry-run flag to preview what would be installed
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateCapabilityMetadata } from "@linchkit/core";
import type { CapabilityMetadata } from "@linchkit/core";
import { defineCommand } from "citty";

/**
 * Resolve the path to a package's capability.json.
 * Handles both npm packages (node_modules/<name>) and local paths.
 */
function resolveCapabilityJsonPath(packageName: string): string {
  if (packageName.startsWith(".") || packageName.startsWith("/")) {
    // Local path
    return resolve(process.cwd(), packageName, "capability.json");
  }
  // npm package — look in node_modules
  return resolve(process.cwd(), "node_modules", packageName, "capability.json");
}

/**
 * Load and validate capability metadata from a capability.json path.
 * Returns null if the file does not exist or is not a valid capability.
 */
export function loadCapabilityMetadata(
  capJsonPath: string,
): CapabilityMetadata | null {
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
 * Summarize extensions from capability metadata for display.
 */
function summarizeExtensions(extensions: Record<string, unknown> | undefined): string {
  if (!extensions) return "none";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(extensions)) {
    if (Array.isArray(value) && value.length > 0) {
      parts.push(`${key}: ${value.join(", ")}`);
    }
  }
  return parts.length > 0 ? parts.join("; ") : "none";
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
      // Found a cycle — extract the cycle path
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

  for (const depName of metadata.dependencies) {
    const depMeta = getDepMetadata(depName);
    if (!depMeta) continue; // Skip unresolvable deps (reported separately)

    // Adapter cannot depend on another adapter
    if (metadata.type === "adapter" && depMeta.type === "adapter") {
      errors.push(
        `Adapter capability "${metadata.name}" cannot depend on adapter "${depMeta.name}". ` +
          `Adapters should only depend on standard or bridge capabilities.`,
      );
    }
  }

  // Bridge should depend on at least one standard capability
  if (metadata.type === "bridge") {
    const hasStandardDep = metadata.dependencies.some((depName) => {
      const depMeta = getDepMetadata(depName);
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

export const installCommand = defineCommand({
  meta: {
    name: "install",
    description: "Install a capability package and validate its metadata",
  },
  args: {
    packageName: {
      type: "positional",
      description: "npm package name or local path (e.g. @linchkit/cap-auth or ./my-capability)",
      required: true,
    },
    dev: {
      type: "boolean",
      description: "Install as devDependency",
      default: false,
    },
    "dry-run": {
      type: "boolean",
      description: "Preview what would be installed without actually installing",
      default: false,
    },
  },
  async run({ args }) {
    const packageName = args.packageName;
    const isDev = args.dev;
    const isDryRun = args["dry-run"] as boolean;

    if (isDryRun) {
      console.log("[linch] Dry run mode — no changes will be made.\n");
    }

    // In dry-run mode, try to locate capability.json without installing
    if (isDryRun) {
      const capabilityJsonPath = resolveCapabilityJsonPath(packageName);

      if (!existsSync(capabilityJsonPath)) {
        console.log(`[linch] Would install: ${packageName}`);
        console.log(`[linch] No capability.json found at ${capabilityJsonPath}`);
        console.log("[linch] Cannot preview metadata — package not yet installed.");
        return;
      }

      // Read and validate
      let raw: unknown;
      try {
        const content = readFileSync(capabilityJsonPath, "utf-8");
        raw = JSON.parse(content);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[linch] Failed to read capability.json: ${msg}`);
        return;
      }

      const validation = validateCapabilityMetadata(raw);
      if (!validation.success) {
        console.warn("[linch] capability.json validation failed:");
        for (const issue of validation.errors) {
          console.warn(`  - ${issue.path.join(".")}: ${issue.message}`);
        }
        return;
      }

      const metadata = validation.data;

      console.log(`[linch] Would install capability: ${metadata.label}`);
      console.log(`  Name:       ${metadata.name}`);
      console.log(`  Version:    ${metadata.version}`);
      console.log(`  Type:       ${metadata.type}`);
      console.log(`  Category:   ${metadata.category}`);
      if (metadata.description) {
        console.log(`  Description: ${metadata.description}`);
      }
      console.log(
        `  Extensions: ${summarizeExtensions(metadata.extensions as Record<string, unknown> | undefined)}`,
      );

      // Check dependencies
      if (metadata.dependencies && metadata.dependencies.length > 0) {
        console.log(`  Dependencies: ${metadata.dependencies.join(", ")}`);
        const missingDeps: string[] = [];
        for (const dep of metadata.dependencies) {
          const depPath = resolve(process.cwd(), "node_modules", dep);
          if (!existsSync(depPath)) {
            missingDeps.push(dep);
          }
        }
        if (missingDeps.length > 0) {
          console.log("");
          console.warn("[linch] Missing dependencies (would need installing):");
          for (const dep of missingDeps) {
            console.warn(`  - ${dep}`);
          }
        }
      }

      // DAG cycle check
      const cycle = detectDependencyCycle(metadata.name, (name) => {
        const depPath = resolveCapabilityJsonPath(name);
        const depMeta = loadCapabilityMetadata(depPath);
        return depMeta?.dependencies ?? [];
      });
      if (cycle) {
        console.log("");
        console.error(`[linch] Dependency cycle detected: ${cycle.join(" -> ")}`);
      }

      // Type compatibility check
      const compat = validateTypeCompatibility(metadata, (depName) => {
        const depPath = resolveCapabilityJsonPath(depName);
        return loadCapabilityMetadata(depPath);
      });
      for (const err of compat.errors) {
        console.error(`[linch] Type compatibility error: ${err}`);
      }
      for (const warn of compat.warnings) {
        console.warn(`[linch] Type compatibility warning: ${warn}`);
      }

      return;
    }

    // Step 1: Run bun add
    const addArgs = ["bun", "add"];
    if (isDev) addArgs.push("-d");
    addArgs.push(packageName);

    console.log(`[linch] Installing ${packageName}...`);

    const result = Bun.spawnSync(addArgs, {
      cwd: process.cwd(),
      stdout: "inherit",
      stderr: "inherit",
    });

    if (result.exitCode !== 0) {
      console.error(`[linch] Failed to install ${packageName}`);
      process.exit(1);
    }

    console.log(`[linch] Package ${packageName} installed successfully.`);

    // Step 2: Locate capability.json
    const capabilityJsonPath = resolveCapabilityJsonPath(packageName);

    if (!existsSync(capabilityJsonPath)) {
      console.log(`[linch] No capability.json found at ${capabilityJsonPath}`);
      console.log(
        "[linch] This package may be a regular npm dependency (not a LinchKit capability).",
      );
      return;
    }

    // Step 3: Read and validate capability.json
    let raw: unknown;
    try {
      const content = readFileSync(capabilityJsonPath, "utf-8");
      raw = JSON.parse(content);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[linch] Failed to read capability.json: ${msg}`);
      return;
    }

    const validation = validateCapabilityMetadata(raw);

    if (!validation.success) {
      console.warn("[linch] capability.json validation failed:");
      for (const issue of validation.errors) {
        console.warn(`  - ${issue.path.join(".")}: ${issue.message}`);
      }
      console.warn("[linch] Package is installed but metadata is invalid.");
      return;
    }

    const metadata = validation.data;

    // Step 4: DAG cycle check
    const cycle = detectDependencyCycle(metadata.name, (name) => {
      const depJsonPath = resolveCapabilityJsonPath(name);
      const depMeta = loadCapabilityMetadata(depJsonPath);
      return depMeta?.dependencies ?? [];
    });

    if (cycle) {
      console.error("");
      console.error(`[linch] Dependency cycle detected: ${cycle.join(" -> ")}`);
      console.error("[linch] Package is installed but has a circular dependency chain.");
    }

    // Step 5: Type compatibility check
    const compat = validateTypeCompatibility(metadata, (depName) => {
      const depPath = resolveCapabilityJsonPath(depName);
      return loadCapabilityMetadata(depPath);
    });

    for (const err of compat.errors) {
      console.error(`[linch] Type compatibility error: ${err}`);
    }
    for (const warn of compat.warnings) {
      console.warn(`[linch] Type compatibility warning: ${warn}`);
    }

    // Step 6: Check dependencies
    const missingDeps: string[] = [];
    if (metadata.dependencies && metadata.dependencies.length > 0) {
      for (const dep of metadata.dependencies) {
        const depPath = resolve(process.cwd(), "node_modules", dep);
        if (!existsSync(depPath)) {
          missingDeps.push(dep);
        }
      }
    }

    // Step 7: Print success message
    console.log("");
    console.log(`[linch] Capability installed: ${metadata.label}`);
    console.log(`  Name:       ${metadata.name}`);
    console.log(`  Version:    ${metadata.version}`);
    console.log(`  Type:       ${metadata.type}`);
    console.log(`  Category:   ${metadata.category}`);
    if (metadata.description) {
      console.log(`  Description: ${metadata.description}`);
    }
    console.log(
      `  Extensions: ${summarizeExtensions(metadata.extensions as Record<string, unknown> | undefined)}`,
    );

    if (missingDeps.length > 0) {
      console.log("");
      console.warn("[linch] Missing capability dependencies:");
      for (const dep of missingDeps) {
        console.warn(`  - ${dep} (install with: linch install ${dep})`);
      }
    }
  },
});
