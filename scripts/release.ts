/**
 * Release script for LinchKit monorepo (changesets-based).
 *
 * Builds packages in dependency order, then runs `changeset publish`
 * to publish only packages with pending version bumps.
 *
 * Usage:
 *   bun scripts/release.ts              # build + publish changed packages
 *   bun scripts/release.ts --dry-run    # show what would be published
 *   bun scripts/release.ts --tag=next   # publish with dist-tag "next"
 */

import { relative, resolve } from "node:path";
import { $, Glob } from "bun";
import { syncCoreVersions } from "./sync-core-version";

const ROOT = resolve(import.meta.dir, "..");
const DRY_RUN = Bun.argv.includes("--dry-run");
const TAG = Bun.argv.find((a) => a.startsWith("--tag="))?.split("=")[1] || "latest";

// ---------------------------------------------------------------------------
// Package discovery
// ---------------------------------------------------------------------------

interface PkgInfo {
  name: string;
  version: string;
  path: string; // relative to ROOT
  private: boolean;
  hasBuild: boolean;
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
        hasBuild: !!pkg.scripts?.build,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Dependency-ordered tiers
// ---------------------------------------------------------------------------

// Tier 0: core (no @linchkit deps)
// Tier 1: depends on core only (devtools, ui-kit)
// Tier 2: everything else (cli, all cap-* addons)
function organizeTiers(packages: PkgInfo[]): PkgInfo[][] {
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
// Build
// ---------------------------------------------------------------------------

async function buildPackage(pkg: PkgInfo): Promise<boolean> {
  if (!pkg.hasBuild) return true;

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
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\nLinchKit Release${DRY_RUN ? " (DRY RUN)" : ""}`);
  console.log(`Tag: ${TAG}\n`);

  // Discover all packages
  const allPackages = await discoverPackages();
  const publishable = allPackages.filter((p) => !p.private);

  console.log(`Found ${allPackages.length} packages, ${publishable.length} publishable:\n`);
  for (const pkg of publishable) {
    console.log(`  ${pkg.name}@${pkg.version}  (${pkg.path})`);
  }
  console.log();

  // Build in dependency order
  const tiers = organizeTiers(allPackages);
  const buildFailed: string[] = [];

  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i];
    console.log(`\n--- Build Tier ${i} (${tier.map((p) => p.name).join(", ")}) ---`);

    const results = await Promise.all(tier.map((pkg) => buildPackage(pkg)));
    for (let j = 0; j < tier.length; j++) {
      if (!results[j]) buildFailed.push(tier[j].name);
    }
  }

  if (buildFailed.length > 0) {
    console.error("\nBuild failures:");
    for (const name of buildFailed) console.error(`  - ${name}`);
    process.exit(1);
  }

  // Core-version sync check (Spec 21 §10.1)
  // After `changeset version`, peerDeps are updated but linchkit.coreVersion may lag.
  // Detect and fix drift here so the published package metadata is always consistent.
  console.log("\n--- Core-version sync (Spec 21 §10.1) ---");
  const { synced: cvSynced, drifted: cvDrifted } = await syncCoreVersions({
    checkOnly: DRY_RUN,
  });
  if (DRY_RUN && cvDrifted.length > 0) {
    for (const name of cvDrifted) {
      console.log(`  [dry-run] Would sync coreVersion: ${name}`);
    }
  } else if (cvSynced.length > 0) {
    for (const name of cvSynced) {
      console.log(`  Synced coreVersion: ${name}`);
    }
    console.log(
      `\n  NOTE: ${cvSynced.length} package(s) had coreVersion drift and were fixed in-place.\n` +
        "  Consider committing these changes or running 'bun run version-packages' next time\n" +
        "  (which includes the sync step automatically).",
    );
  } else if (cvDrifted.length === 0) {
    console.log("  All capability coreVersions are in sync.");
  }

  // Publish via changesets
  console.log("\n--- Publishing via changesets ---");

  if (DRY_RUN) {
    console.log("[dry-run] Would run: bunx changeset publish --tag", TAG);
    console.log("[dry-run] Checking changeset status instead:\n");
    try {
      await $`cd ${ROOT} && bunx changeset status`;
    } catch {
      console.log("No pending changesets (this is normal if versions are already bumped).");
    }
  } else {
    const tagArgs = TAG !== "latest" ? ["--tag", TAG] : [];
    try {
      await $`cd ${ROOT} && bunx changeset publish ${tagArgs}`;
      console.log("\nPublish complete.");
    } catch (e) {
      console.error("\nPublish failed:", (e as Error).message);
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error("Release failed:", err);
  process.exit(1);
});
