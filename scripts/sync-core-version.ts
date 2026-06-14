/**
 * sync-core-version — keep every capability's declared `coreVersion` in lockstep
 * with the actual `@linchkit/core` version (issue #589).
 *
 * WHY THIS EXISTS
 * ---------------
 * The repo versions/publishes with Changesets. `changeset version` bumps
 * `@linchkit/core` (e.g. 0.2.0 → 0.3.0) and rewrites each capability's
 * `peerDependencies["@linchkit/core"]` caret range — but it does NOT touch the
 * `linchkit.coreVersion` field that Capability Lint (Spec 21 §10.1) checks. The
 * lint requires (a) `coreVersion` to EQUAL the concrete peerDep range and (b)
 * `coreVersion` to SATISFY the local core version. So after a core bump
 * `coreVersion` is stale (`^0.2.0`) while core is `0.3.0`, and Capability Lint
 * FAILS on every subsequent PR until a human sweeps all package.json files by
 * hand (this happened — PR #588). This script automates that sweep so a core
 * bump can never again break every PR.
 *
 * WHAT IT DOES
 * ------------
 * Reads the post-bump `@linchkit/core` version from `packages/core/package.json`
 * (the source of truth) and rewrites every `coreVersion` site to the matching
 * caret range `^x.y.z`. It is deterministic and idempotent: running it when
 * already in sync produces no changes.
 *
 * COVERED SITES (see CAP_LOCK_EXTRA_TARGETS + the package.json glob)
 * -----------------------------------------------------------------
 *  - Every `addons/[*]/cap-[*]/package.json` with a `linchkit.coreVersion` field
 *    (JSON read/write, indent + trailing newline preserved).
 *  - cap-lock is the only addon with the value mirrored in extra places:
 *      - `addons/lock/cap-lock/capability.json`            (JSON: linchkit.coreVersion)
 *      - `addons/lock/cap-lock/src/factory.ts`             (literal: `coreVersion: "^x.y.z"`)
 *      - `addons/lock/cap-lock/__tests__/capability.test.ts` (literal in a `toBe(...)` assertion)
 *
 * HOW IT IS WIRED
 * ---------------
 * The release `version` step runs `bunx changeset version && bun scripts/sync-core-version.ts`
 * (see `.github/workflows/publish.yml` and the root `version-packages` script),
 * so the sync runs immediately after the bump, inside the same version commit /
 * "version packages" PR. Choosing the changeset `version` command as the hook —
 * rather than an npm `postversion` lifecycle script — is deliberate: changesets
 * drives versioning through its own `version` command (it does NOT invoke
 * `npm version`, so the `postversion` lifecycle never fires here), and the
 * GitHub Action's `version:` input is the single, documented seam changesets
 * exposes for "run extra work after the bump".
 *
 * USAGE
 *   bun scripts/sync-core-version.ts            # rewrite all coreVersion sites in place
 *   bun scripts/sync-core-version.ts --check    # exit 1 if anything is out of sync (no writes)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Glob } from "bun";

const ROOT = resolve(import.meta.dir, "..");

// ---------------------------------------------------------------------------
// Pure helpers (no I/O — unit tested directly)
// ---------------------------------------------------------------------------

/**
 * The caret range a capability should declare for a given concrete core version.
 * Convention (matches the peerDep range changeset writes): `^<core.version>`.
 */
export function coreVersionRange(coreVersion: string): string {
  return `^${coreVersion}`;
}

/** Read the `.version` field from a parsed `@linchkit/core` package.json string. */
export function readCoreVersion(corePkgJson: string): string {
  const parsed = JSON.parse(corePkgJson) as { version?: unknown };
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error("packages/core/package.json has no usable .version field");
  }
  return parsed.version;
}

/**
 * Rewrite the `linchkit.coreVersion` field of a package.json / capability.json
 * source string to `range`, preserving the original indentation (2-space) and
 * trailing newline. Parses + re-stringifies the JSON rather than regexing it.
 *
 * Returns `{ text, changed }`. `changed` is false when there is no
 * `linchkit.coreVersion` field OR it already equals `range` (idempotent).
 */
export function syncJsonCoreVersion(
  source: string,
  range: string,
): { text: string; changed: boolean } {
  const data = JSON.parse(source) as Record<string, unknown>;
  const linchkit = data.linchkit;
  if (typeof linchkit !== "object" || linchkit === null) {
    return { text: source, changed: false };
  }
  const block = linchkit as Record<string, unknown>;
  if (typeof block.coreVersion !== "string") {
    return { text: source, changed: false };
  }
  if (block.coreVersion === range) {
    return { text: source, changed: false };
  }
  block.coreVersion = range;
  const trailingNewline = source.endsWith("\n") ? "\n" : "";
  return { text: `${JSON.stringify(data, null, 2)}${trailingNewline}`, changed: true };
}

/**
 * Replace a `coreVersion: "<range>"` object-property literal (e.g. inside
 * cap-lock's `factory.ts` `defineCapability({ ... coreVersion: "^0.2.0" ... })`)
 * with the target `range`. Robust to surrounding whitespace and either quote
 * style; only the version string between the quotes is touched. Idempotent.
 */
export function syncFactoryCoreVersion(
  source: string,
  range: string,
): { text: string; changed: boolean } {
  // Matches:  coreVersion <ws> : <ws> ("..." | '...')
  const re = /(\bcoreVersion[ \t]*:[ \t]*)(["'])[^"']*\2/;
  const m = source.match(re);
  if (!m) return { text: source, changed: false };
  const replacement = `${m[1]}${m[2]}${range}${m[2]}`;
  if (m[0] === replacement) return { text: source, changed: false };
  return { text: source.replace(re, replacement), changed: true };
}

/**
 * Replace the version literal inside the cap-lock test's
 * `expect(capLock.coreVersion).toBe("<range>")` assertion with `range`.
 * Robust to whitespace and quote style; idempotent.
 */
export function syncTestCoreVersion(
  source: string,
  range: string,
): { text: string; changed: boolean } {
  // Matches:  .coreVersion ... toBe ( ("..." | '...') )
  const re = /(\.coreVersion[\s\S]*?\.toBe[ \t]*\([ \t]*)(["'])[^"']*\2/;
  const m = source.match(re);
  if (!m) return { text: source, changed: false };
  const replacement = `${m[1]}${m[2]}${range}${m[2]}`;
  if (m[0] === replacement) return { text: source, changed: false };
  return { text: source.replace(re, replacement), changed: true };
}

// ---------------------------------------------------------------------------
// Sync plan (which file gets which strategy) — pure, given the file list
// ---------------------------------------------------------------------------

export type SyncStrategy = "json" | "factory" | "test";

export interface SyncTarget {
  /** Path relative to repo root. */
  path: string;
  strategy: SyncStrategy;
}

/** cap-lock's capability.json + its two non-JSON mirror sites, relative to ROOT. */
const CAP_LOCK_EXTRA_TARGETS: SyncTarget[] = [
  { path: "addons/lock/cap-lock/capability.json", strategy: "json" },
  { path: "addons/lock/cap-lock/src/factory.ts", strategy: "factory" },
  { path: "addons/lock/cap-lock/__tests__/capability.test.ts", strategy: "test" },
];

/**
 * Apply the strategy that matches a target to its source text. Pure dispatcher
 * so the test can exercise the full plan against in-memory fixtures.
 */
export function applySync(
  strategy: SyncStrategy,
  source: string,
  range: string,
): { text: string; changed: boolean } {
  switch (strategy) {
    case "json":
      return syncJsonCoreVersion(source, range);
    case "factory":
      return syncFactoryCoreVersion(source, range);
    case "test":
      return syncTestCoreVersion(source, range);
  }
}

// ---------------------------------------------------------------------------
// I/O orchestration
// ---------------------------------------------------------------------------

/** Discover every capability package.json that declares a linchkit.coreVersion. */
async function discoverJsonTargets(): Promise<SyncTarget[]> {
  const out: SyncTarget[] = [];
  const glob = new Glob("addons/*/cap-*/package.json");
  for await (const match of glob.scan({ cwd: ROOT })) {
    out.push({ path: match, strategy: "json" });
  }
  return out;
}

async function main(): Promise<void> {
  const checkOnly = Bun.argv.includes("--check");

  const corePkg = readFileSync(resolve(ROOT, "packages/core/package.json"), "utf-8");
  const range = coreVersionRange(readCoreVersion(corePkg));

  const jsonTargets = await discoverJsonTargets();
  const targets = [...jsonTargets, ...CAP_LOCK_EXTRA_TARGETS].sort((a, b) =>
    a.path.localeCompare(b.path),
  );

  const drifted: string[] = [];
  const missing: string[] = [];
  const plannedWrites: { full: string; text: string }[] = [];

  // Pass 1 — read every target and compute the plan. NO file is written here, so
  // a moved/renamed mirror site is detected BEFORE anything is mutated; the
  // missing-target failure below can never leave a partially-synced tree.
  for (const target of targets) {
    const full = resolve(ROOT, target.path);
    let source: string;
    try {
      source = readFileSync(full, "utf-8");
    } catch {
      // A non-JSON cap-lock site could be moved/renamed; collect it and fail
      // loudly below so a refactor that drops a mirror site can't silently
      // leave it un-synced.
      missing.push(target.path);
      continue;
    }

    const { text, changed } = applySync(target.strategy, source, range);
    if (!changed) continue;

    drifted.push(target.path);
    plannedWrites.push({ full, text });
  }

  // A missing mirror site is a hard error in BOTH modes. Report it and exit
  // BEFORE any write or success-style logging, so the output is never
  // self-contradictory (exit 1 paired with an "in sync" message) AND no file is
  // written when another target is missing (no partial sync).
  if (missing.length > 0) {
    console.error(
      `[sync-core-version] MISSING target file(s) (${missing.length}) — a mirror site was moved or renamed:`,
    );
    for (const p of missing) console.error(`  - ${p}`);
    console.error("Update CAP_LOCK_EXTRA_TARGETS in scripts/sync-core-version.ts.");
    process.exit(1);
  }

  // Pass 2 — apply the planned writes. Only reached when every target was
  // readable, so the sync is all-or-nothing with respect to a missing mirror.
  if (!checkOnly) {
    for (const { full, text } of plannedWrites) {
      writeFileSync(full, text, "utf-8");
    }
  }

  if (checkOnly) {
    if (drifted.length > 0) {
      console.error(
        `[sync-core-version] OUT OF SYNC with @linchkit/core ${range} (${drifted.length} file(s)):`,
      );
      for (const p of drifted) console.error(`  - ${p}`);
      console.error("Run: bun scripts/sync-core-version.ts");
      process.exit(1);
    }
    console.log(`[sync-core-version] all coreVersion sites in sync with ${range}`);
    return;
  }

  if (drifted.length === 0) {
    console.log(`[sync-core-version] already in sync with @linchkit/core ${range}`);
  } else {
    console.log(`[sync-core-version] synced ${drifted.length} file(s) to ${range}:`);
    for (const p of drifted) console.log(`  - ${p}`);
  }
}

// Run only when invoked directly (not when imported by the unit test).
if (import.meta.main) {
  main().catch((err) => {
    console.error("[sync-core-version] failed:", err);
    process.exit(1);
  });
}
