/**
 * Capability registry aggregator
 *
 * Builds a CapabilityRegistry from actual CapabilityDefinition objects
 * loaded via linchkit.config.ts, enriched with npm metadata (package name,
 * version) from the corresponding package.json files in addons/.
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { CapabilityDefinition } from "@linchkit/core";
import type { CapabilityRegistry, CapabilityRegistryEntry } from "./types";

/** Shape of the `linchkit` field in addon package.json */
interface LinchKitPackageField {
  type?: "standard" | "adapter" | "bridge";
  category?: string;
  compatibility?: string;
  minCoreVersion?: string;
}

/** Minimal package.json shape we read */
interface PackageJson {
  name?: string;
  version?: string;
  description?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  linchkit?: LinchKitPackageField;
}

/**
 * Recursively find all package.json files under a directory,
 * stopping descent at node_modules.
 */
async function findPackageJsonFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return results;
  }

  for (const name of names) {
    if (name === "node_modules" || name === ".git") continue;

    const fullPath = join(dir, name);
    const info = await stat(fullPath).catch(() => null);
    if (!info) continue;

    if (info.isDirectory()) {
      const nested = await findPackageJsonFiles(fullPath);
      results.push(...nested);
    } else if (name === "package.json") {
      results.push(fullPath);
    }
  }

  return results;
}

/**
 * Extract capability dependency names from a package.json.
 * Only includes @linchkit/cap-* packages, excluding self.
 */
function extractCapabilityDeps(pkg: PackageJson): string[] {
  const allDeps: Record<string, string> = {
    ...pkg.dependencies,
    ...pkg.peerDependencies,
  };

  return Object.keys(allDeps).filter((dep) => dep.startsWith("@linchkit/cap-") && dep !== pkg.name);
}

/**
 * Build a lookup map from capability name (e.g. "cap-chatter") to
 * its package.json data, by scanning the addons directory.
 */
async function buildPackageJsonMap(addonsDir: string): Promise<Map<string, PackageJson>> {
  const map = new Map<string, PackageJson>();

  try {
    await stat(addonsDir);
  } catch {
    return map;
  }

  const packageFiles = await findPackageJsonFiles(addonsDir);

  for (const filePath of packageFiles) {
    try {
      const file = Bun.file(filePath);
      const pkg = (await file.json()) as PackageJson;
      if (!pkg.name) continue;

      // Derive capability name from npm package name:
      // @linchkit/cap-chatter -> cap-chatter
      const capName = pkg.name.replace(/^@linchkit\//, "");
      map.set(capName, pkg);
    } catch {
      // Skip unreadable or invalid package.json files
    }
  }

  return map;
}

/**
 * Build a CapabilityRegistryEntry from a CapabilityDefinition and
 * optional package.json metadata.
 */
function buildEntry(
  cap: CapabilityDefinition,
  pkg: PackageJson | undefined,
): CapabilityRegistryEntry {
  return {
    name: pkg?.name ?? `@linchkit/${cap.name}`,
    version: pkg?.version ?? cap.version,
    description: cap.description ?? pkg?.description ?? "",
    type: cap.type,
    category: cap.category,
    compatibility: pkg?.peerDependencies?.["@linchkit/core"] ?? "^0.1.0",
    dependencies: pkg ? extractCapabilityDeps(pkg) : (cap.dependencies ?? []),
    official: true,
  };
}

/**
 * Build a CapabilityRegistryEntry directly from a package.json
 * with a `linchkit` field (no CapabilityDefinition needed).
 */
function buildEntryFromPackageJson(pkg: PackageJson): CapabilityRegistryEntry | null {
  if (!pkg.linchkit || !pkg.name) return null;

  const lk = pkg.linchkit;
  return {
    name: pkg.name,
    version: pkg.version ?? "0.0.0",
    description: pkg.description ?? "",
    type: lk.type ?? "standard",
    category: lk.category ?? "uncategorized",
    compatibility: lk.compatibility ?? lk.minCoreVersion ?? "^0.1.0",
    dependencies: extractCapabilityDeps(pkg),
    official: true,
  };
}

/**
 * Aggregate a CapabilityRegistry by scanning addon package.json files.
 *
 * When CapabilityDefinitions are provided (from linchkit.config.ts),
 * they are used as the source of truth, enriched with package.json metadata.
 * When no capabilities are provided, package.json files with a `linchkit`
 * field are scanned directly from the addons directory.
 *
 * @param projectRoot - Project root directory (contains addons/)
 * @param capabilities - Optional CapabilityDefinitions from linchkit.config.ts
 */
export async function aggregateRegistry(
  projectRoot: string,
  capabilities?: CapabilityDefinition[],
): Promise<CapabilityRegistry> {
  const addonsDir = join(projectRoot, "addons");
  const pkgMap = await buildPackageJsonMap(addonsDir);

  const entries: CapabilityRegistryEntry[] = [];

  if (capabilities && capabilities.length > 0) {
    // Config-based mode: use CapabilityDefinitions enriched with package.json
    for (const cap of capabilities) {
      const pkg = pkgMap.get(cap.name);
      entries.push(buildEntry(cap, pkg));
    }
  } else {
    // Scan mode: discover all addons with a `linchkit` field in package.json
    for (const pkg of pkgMap.values()) {
      const entry = buildEntryFromPackageJson(pkg);
      if (entry) entries.push(entry);
    }
  }

  // Sort by name for stable output
  entries.sort((a, b) => a.name.localeCompare(b.name));

  return {
    version: "1.0",
    generated: new Date().toISOString(),
    capabilities: entries,
  };
}
