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
import {
  checkTrustPermissions,
  computeEffectiveTrust,
  coreVersionRangeOf,
  satisfiesVersionRange,
  VERSION,
} from "@linchkit/core";
import { defineCommand } from "citty";
import { registerCapability } from "../utils/local-registry-io";
import {
  detectDependencyCycle,
  loadCapabilityMetadata,
  resolveCapabilityJsonPath,
  validateTypeCompatibility,
} from "./install-utils";

export {
  detectDependencyCycle,
  inferTrustLevel,
  loadCapabilityMetadata,
  resolveCapabilityJsonPath,
  validateTypeCompatibility,
} from "./install-utils";

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

    // Step 7: Trust level check.
    // Effective trust = clamp(declared ?? inferred). A capability MAY declare a
    // `trustLevel` in its capability.json, but the declaration can only LOWER
    // its standing — never exceed what the package name justifies (anti-spoof).
    // Infer from the CANONICAL `metadata.name` (from capability.json), NOT the
    // install argument `packageName` — the latter is a path string for local
    // installs (e.g. `./local-cap`), which would mis-infer every local install
    // as `unverified`. This matches publish.ts.
    const trustLevel = computeEffectiveTrust({
      name: metadata.name,
      declaredTrust: metadata.trustLevel,
    });
    if (trustLevel === "unverified") {
      console.warn("");
      console.warn("[linch] Trust level: unverified");
      console.warn("  This capability is not in the LinchKit registry.");
    } else if (trustLevel === "community") {
      console.log("");
      console.log("[linch] Trust level: community");
      console.log(
        "  This capability has passed automated checks but has not been manually reviewed.",
      );
    }

    // Step 8: Check system permission compatibility with trust level
    const capExt = metadata.extensions as Record<string, unknown> | undefined;
    const systemPerms = (capExt?.systemPermissions as string[] | undefined) ?? [];
    if (systemPerms.length > 0) {
      const permCheck = checkTrustPermissions(trustLevel, systemPerms);
      if (!permCheck.allowed) {
        console.warn("");
        console.warn(
          `[linch] Trust level "${trustLevel}" does not allow system permissions: ${permCheck.denied.join(", ")}`,
        );
      }
    }

    // Step 9: Core version compatibility check.
    // Prefer the new `coreVersion` semver range; fall back to the deprecated
    // `minVersion` (normalized to a `>=` range) for capabilities that have not
    // migrated yet.
    const coreVersionRange = coreVersionRangeOf(metadata.linchkit);
    if (coreVersionRange) {
      const compatible = satisfiesVersionRange(VERSION, coreVersionRange);
      if (!compatible) {
        console.warn("");
        console.warn(
          `[linch] Version warning: ${metadata.name} requires @linchkit/core ${coreVersionRange}, you have ${VERSION}`,
        );
      }
    }

    // Step 10: Print success message
    console.log("");
    console.log(`[linch] Capability installed: ${metadata.label}`);
    console.log(`  Name:       ${metadata.name}`);
    console.log(`  Version:    ${metadata.version}`);
    console.log(`  Type:       ${metadata.type}`);
    console.log(`  Category:   ${metadata.category}`);
    console.log(`  Trust:      ${trustLevel}`);
    if (metadata.description) {
      console.log(`  Description: ${metadata.description}`);
    }
    console.log(`  Extensions: ${summarizeExtensions(capExt)}`);

    if (missingDeps.length > 0) {
      console.log("");
      console.warn("[linch] Missing capability dependencies:");
      for (const dep of missingDeps) {
        console.warn(`  - ${dep} (install with: linch install ${dep})`);
      }
    }

    // Step 11: Register to local capability registry
    registerCapability(process.cwd(), {
      name: metadata.name,
      version: metadata.version,
      type: metadata.type,
      category: metadata.category,
      label: metadata.label,
      description: metadata.description,
      trustLevel,
      author: metadata.author,
      repository: metadata.repository,
      dependencies: metadata.dependencies,
      minCoreVersion: coreVersionRange,
      installedAt: new Date().toISOString(),
    });
  },
});
