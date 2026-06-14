/**
 * sync-core-version — sync linchkit.coreVersion in capability package.json
 * files to match their peerDependencies["@linchkit/core"] range.
 *
 * Run after `changeset version` (i.e. as part of `bun run version-packages`)
 * to keep Capability Lint (Spec 21 §10.1) green without manual follow-up.
 *
 * Usage:
 *   bun scripts/sync-core-version.ts           # sync in place
 *   bun scripts/sync-core-version.ts --check   # validate only, exit 1 on drift
 */

import { resolve } from "node:path";
import { Glob } from "bun";

const ROOT_ARG = Bun.argv.find((a) => a.startsWith("--root="))?.slice("--root=".length);
const ROOT = ROOT_ARG ? resolve(ROOT_ARG) : resolve(import.meta.dir, "..");
const CHECK_ONLY = Bun.argv.includes("--check");

interface CapabilityPkg {
  name: string;
  pkgPath: string;
  pkg: Record<string, unknown>;
}

async function discoverCapabilityPackages(root: string): Promise<CapabilityPkg[]> {
  const patterns = [
    "addons/*/cap-*/package.json",
    "addons/adapter-ui/cap-adapter-ui/ui-kit/package.json",
  ];

  const seen = new Set<string>();
  const results: CapabilityPkg[] = [];

  for (const pattern of patterns) {
    const glob = new Glob(pattern);
    for await (const match of glob.scan({ cwd: root })) {
      const pkgPath = resolve(root, match);
      if (seen.has(pkgPath)) continue;
      seen.add(pkgPath);
      const pkg = (await Bun.file(pkgPath).json()) as Record<string, unknown>;
      results.push({
        name: typeof pkg.name === "string" ? pkg.name : match,
        pkgPath,
        pkg,
      });
    }
  }

  return results;
}

export async function syncCoreVersions(opts: { checkOnly: boolean; root?: string }): Promise<{
  synced: string[];
  drifted: string[];
}> {
  const root = opts.root ?? ROOT;
  const caps = await discoverCapabilityPackages(root);
  const synced: string[] = [];
  const drifted: string[] = [];

  for (const { name, pkgPath, pkg } of caps) {
    const peerDeps =
      typeof pkg.peerDependencies === "object" && pkg.peerDependencies !== null
        ? (pkg.peerDependencies as Record<string, string>)
        : {};
    const peerCore = peerDeps["@linchkit/core"];

    // Skip: no @linchkit/core peer, or workspace: protocol (monorepo local).
    if (typeof peerCore !== "string" || peerCore.startsWith("workspace:")) continue;

    const linchkitBlock =
      typeof pkg.linchkit === "object" && pkg.linchkit !== null
        ? { ...(pkg.linchkit as Record<string, unknown>) }
        : null;

    // No linchkit block at all — not our job to create one; skip.
    if (linchkitBlock === null) continue;

    if (linchkitBlock.coreVersion === peerCore) continue;

    drifted.push(name);

    if (!opts.checkOnly) {
      linchkitBlock.coreVersion = peerCore;
      pkg.linchkit = linchkitBlock;
      await Bun.write(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
      synced.push(name);
    }
  }

  return { synced, drifted };
}

async function main() {
  console.log(`sync-core-version${CHECK_ONLY ? " (check only)" : ""}\n`);

  const { synced, drifted } = await syncCoreVersions({ checkOnly: CHECK_ONLY });

  if (CHECK_ONLY) {
    if (drifted.length === 0) {
      console.log("All capability coreVersions are in sync.");
      return;
    }
    for (const name of drifted) {
      console.error(
        `  DRIFT: ${name} — linchkit.coreVersion does not match peerDependencies["@linchkit/core"]`,
      );
    }
    console.error(
      `\n${drifted.length} capability package(s) have coreVersion drift.\n` +
        "Run: bun scripts/sync-core-version.ts\n" +
        "  or: bun run version-packages   (which includes the sync step)",
    );
    process.exit(1);
  }

  if (synced.length === 0) {
    console.log("All capability coreVersions are already in sync.");
    return;
  }

  for (const name of synced) {
    console.log(`  Synced: ${name}`);
  }
  console.log(`\nSynced ${synced.length} capability package(s).`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("sync-core-version failed:", err);
    process.exit(1);
  });
}
