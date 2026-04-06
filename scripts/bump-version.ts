/**
 * Bump version across all LinchKit packages simultaneously.
 *
 * Usage:
 *   bun scripts/bump-version.ts 0.2.0
 *
 * Updates:
 *   - "version" field in every non-private package.json
 *   - peerDependency ranges for @linchkit/* packages (e.g. ^0.1.0 -> ^0.2.0)
 *   - linchkit.minCoreVersion if present
 */

import { relative, resolve } from "node:path";
import { Glob } from "bun";

const ROOT = resolve(import.meta.dir, "..");

const newVersion = Bun.argv[2];
if (!newVersion || !/^\d+\.\d+\.\d+/.test(newVersion)) {
  console.error("Usage: bun scripts/bump-version.ts <version>");
  console.error("Example: bun scripts/bump-version.ts 0.2.0");
  process.exit(1);
}

const newRange = `^${newVersion}`;

// ---------------------------------------------------------------------------
// Discover all workspace package.json files
// ---------------------------------------------------------------------------

async function discoverPackageJsons(): Promise<string[]> {
  const patterns = [
    "packages/*/package.json",
    "addons/*/cap-*/package.json",
    "addons/adapter-ui/cap-adapter-ui/ui-kit/package.json",
  ];

  const results: string[] = [];
  for (const pattern of patterns) {
    const glob = new Glob(pattern);
    for await (const match of glob.scan({ cwd: ROOT })) {
      results.push(resolve(ROOT, match));
    }
  }
  return results.sort();
}

// ---------------------------------------------------------------------------
// Update a single package.json
// ---------------------------------------------------------------------------

function updateLinchkitRanges(deps: Record<string, string> | undefined): boolean {
  if (!deps) return false;
  let changed = false;
  for (const [key, value] of Object.entries(deps)) {
    if (key.startsWith("@linchkit/") && !value.startsWith("workspace:")) {
      deps[key] = newRange;
      changed = true;
    }
  }
  return changed;
}

async function updatePackageJson(filePath: string): Promise<boolean> {
  const raw = await Bun.file(filePath).text();
  const pkg = JSON.parse(raw);
  const relPath = relative(ROOT, filePath);

  // Skip private packages (like demo)
  if (pkg.private) {
    console.log(`  skip (private): ${relPath}`);
    return false;
  }

  let changed = false;

  // Update version
  if (pkg.version !== newVersion) {
    pkg.version = newVersion;
    changed = true;
  }

  // Update peerDependencies ranges
  if (updateLinchkitRanges(pkg.peerDependencies)) changed = true;

  // Update linchkit.minCoreVersion
  if (pkg.linchkit?.minCoreVersion) {
    pkg.linchkit.minCoreVersion = newRange;
    changed = true;
  }

  if (changed) {
    await Bun.write(filePath, `${JSON.stringify(pkg, null, 2)}\n`);
    console.log(`  updated: ${relPath} -> ${newVersion}`);
  } else {
    console.log(`  unchanged: ${relPath}`);
  }

  return changed;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\nBumping all packages to ${newVersion}\n`);

  const files = await discoverPackageJsons();
  let updatedCount = 0;

  for (const f of files) {
    const updated = await updatePackageJson(f);
    if (updated) updatedCount++;
  }

  console.log(`\nDone. Updated ${updatedCount} / ${files.length} packages.\n`);
}

main().catch((err) => {
  console.error("Bump failed:", err);
  process.exit(1);
});
