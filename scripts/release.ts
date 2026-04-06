/**
 * Release script for LinchKit monorepo.
 *
 * Usage:
 *   bun scripts/release.ts              # publish all packages
 *   bun scripts/release.ts --dry-run    # show what would be published
 *   bun scripts/release.ts --tag=next   # publish with dist-tag "next"
 *
 * Publishes packages in dependency order (tiers).
 * Packages within the same tier are published in parallel.
 */

import { relative, resolve } from "node:path";
import { $, Glob } from "bun";

const ROOT = resolve(import.meta.dir, "..");
const DRY_RUN = Bun.argv.includes("--dry-run");
const TAG = Bun.argv.find((a) => a.startsWith("--tag="))?.split("=")[1] || "latest";

// ---------------------------------------------------------------------------
// Discover all publishable packages
// ---------------------------------------------------------------------------

interface PkgInfo {
  name: string;
  version: string;
  path: string; // relative to ROOT
  private: boolean;
}

async function discoverPackages(): Promise<PkgInfo[]> {
  const patterns = [
    "packages/*/package.json",
    "addons/*/cap-*/package.json",
    "addons/adapter-ui/cap-adapter-ui/ui-kit/package.json",
  ];

  const results: PkgInfo[] = [];

  for (const pattern of patterns) {
    const glob = new Glob(pattern);
    for await (const match of glob.scan({ cwd: ROOT })) {
      const fullPath = resolve(ROOT, match);
      const pkg = await Bun.file(fullPath).json();
      results.push({
        name: pkg.name,
        version: pkg.version,
        path: relative(ROOT, resolve(fullPath, "..")),
        private: pkg.private === true,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Dependency-ordered tiers
// ---------------------------------------------------------------------------

// Tier 0: no @linchkit deps (core)
// Tier 1: depends on core only (devtools, ui-kit)
// Tier 2: everything else (cli, all cap-* addons)
function organizeTiers(packages: PkgInfo[]): PkgInfo[][] {
  const _byName = new Map(packages.map((p) => [p.name, p]));

  const tier0Names = new Set(["@linchkit/core"]);
  const tier1Names = new Set(["@linchkit/devtools", "@linchkit/ui-kit"]);

  const tier0: PkgInfo[] = [];
  const tier1: PkgInfo[] = [];
  const tier2: PkgInfo[] = [];

  for (const pkg of packages) {
    if (pkg.private) continue;
    if (tier0Names.has(pkg.name)) tier0.push(pkg);
    else if (tier1Names.has(pkg.name)) tier1.push(pkg);
    else tier2.push(pkg);
  }

  return [tier0, tier1, tier2].filter((t) => t.length > 0);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

async function validateGitClean(): Promise<boolean> {
  const result = await $`git -C ${ROOT} status --porcelain`.text();
  if (result.trim().length > 0) {
    console.error("ERROR: Uncommitted changes detected. Commit or stash first.");
    console.error(result);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

async function buildPackage(pkg: PkgInfo): Promise<boolean> {
  const pkgJson = await Bun.file(resolve(ROOT, pkg.path, "package.json")).json();
  if (!pkgJson.scripts?.build) {
    return true; // nothing to build
  }

  console.log(`  Building ${pkg.name}...`);
  if (DRY_RUN) {
    console.log(`  [dry-run] Would run: bun run build in ${pkg.path}`);
    return true;
  }

  try {
    await $`cd ${resolve(ROOT, pkg.path)} && bun run build`.quiet();
    console.log(`  Built ${pkg.name}`);
    return true;
  } catch (e) {
    console.error(`  FAILED to build ${pkg.name}:`, (e as Error).message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

async function publishPackage(pkg: PkgInfo): Promise<boolean> {
  const dir = resolve(ROOT, pkg.path);
  const args = ["publish", "--access", "public", "--tag", TAG];

  if (DRY_RUN) {
    console.log(
      `  [dry-run] Would publish: ${pkg.name}@${pkg.version} (tag: ${TAG}) from ${pkg.path}`,
    );
    return true;
  }

  try {
    await $`cd ${dir} && bun ${args}`.quiet();
    console.log(`  Published ${pkg.name}@${pkg.version}`);
    return true;
  } catch (e) {
    console.error(`  FAILED to publish ${pkg.name}:`, (e as Error).message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\nLinchKit Release${DRY_RUN ? " (DRY RUN)" : ""}`);
  console.log(`Tag: ${TAG}\n`);

  // Discover
  const allPackages = await discoverPackages();
  const publishable = allPackages.filter((p) => !p.private);

  console.log(`Found ${allPackages.length} packages, ${publishable.length} publishable:\n`);
  for (const pkg of publishable) {
    console.log(`  ${pkg.name}@${pkg.version}  (${pkg.path})`);
  }
  console.log();

  // Validate git state
  if (!DRY_RUN) {
    const clean = await validateGitClean();
    if (!clean) process.exit(1);
  }

  // Organize into tiers
  const tiers = organizeTiers(allPackages);

  const succeeded: string[] = [];
  const failed: string[] = [];

  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i];
    console.log(`\n--- Tier ${i} (${tier.map((p) => p.name).join(", ")}) ---`);

    // Build all in tier
    console.log("Building...");
    const buildResults = await Promise.all(tier.map((pkg) => buildPackage(pkg)));
    for (let j = 0; j < tier.length; j++) {
      if (!buildResults[j]) {
        console.error(`  Skipping publish for ${tier[j].name} due to build failure`);
        failed.push(tier[j].name);
      }
    }

    // Publish all successfully built packages in this tier
    console.log("Publishing...");
    const publishPromises = tier.map(async (pkg, j) => {
      if (!buildResults[j]) return; // skip failed builds
      const ok = await publishPackage(pkg);
      if (ok) succeeded.push(pkg.name);
      else failed.push(pkg.name);
    });
    await Promise.all(publishPromises);
  }

  // Summary
  console.log("\n========== SUMMARY ==========");
  console.log(`Succeeded: ${succeeded.length}`);
  for (const name of succeeded) console.log(`  + ${name}`);
  if (failed.length > 0) {
    console.log(`Failed: ${failed.length}`);
    for (const name of failed) console.log(`  - ${name}`);
  }
  console.log("=============================\n");

  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Release failed:", err);
  process.exit(1);
});
