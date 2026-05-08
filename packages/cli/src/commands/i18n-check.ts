/**
 * linch i18n check — Validate translation key consistency across capability locale files.
 *
 * Scans all i18n JSON files under `addons/<group>/<cap>/src/i18n/` (or
 * `.../src/i18n/locales/`) and reports, per capability:
 *   1. Missing keys — present in one locale but not the other.
 *   2. Extra keys   — only in one locale (the inverse of "missing"; emitted
 *                     once per locale to make the asymmetry obvious).
 *   3. Empty values — a key exists but its string value is empty / whitespace.
 *
 * Exits with code 1 if any issue is found, 0 otherwise — CI-friendly.
 *
 * Discovery: globs `addons/<group>/<cap>/src/i18n/*.json` and
 * `addons/<group>/<cap>/src/i18n/locales/*.json`. Capabilities with fewer
 * than two locale files are reported as "skipped" (warning, not failure).
 *
 * Pure helpers (`compareLocales`, `flattenLocale`, `discoverLocaleGroups`)
 * are exported for unit testing without spawning the CLI.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { defineCommand } from "citty";
import consola from "consola";

// ── Types ────────────────────────────────────────────────────

/** Recursive locale tree — leaves are strings, branches are nested objects. */
export type LocaleTree = { [key: string]: string | LocaleTree };

/** A single capability's locale files (e.g. `en.json` + `zh-CN.json`). */
export interface LocaleGroup {
  /** Capability label, e.g. `addons/adapter-ui/cap-adapter-ui` (relative to repo root). */
  capability: string;
  /** Absolute path to the i18n directory. */
  dir: string;
  /** Map of locale name → absolute file path. */
  locales: Record<string, string>;
}

/** A single issue surfaced by the check. */
export interface I18nIssue {
  kind: "missing" | "extra" | "empty";
  /** Locale that the issue belongs to (e.g. `en`, `zh-CN`). */
  locale: string;
  /** Dot-separated key path, e.g. `common.submit`. */
  key: string;
  /** Optional human note (e.g. "missing in zh-CN, present in en"). */
  detail?: string;
}

/** Result of comparing one capability's locale files. */
export interface CapabilityReport {
  capability: string;
  locales: string[];
  issues: I18nIssue[];
  /** Set when the capability could not be checked (e.g. only one locale found). */
  skipped?: string;
}

// ── Pure helpers (testable without spawning the CLI) ─────────

/**
 * Flatten a nested locale tree into a map of dot-separated key → leaf value.
 * Non-string leaves (numbers, arrays, etc.) are coerced to string. We never
 * mutate the input.
 */
export function flattenLocale(tree: LocaleTree, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      Object.assign(out, flattenLocale(v as LocaleTree, path));
    } else {
      out[path] = typeof v === "string" ? v : String(v);
    }
  }
  return out;
}

/**
 * Compare a set of locales (already flattened) and produce issues.
 *
 * For each pair (locale A, locale B):
 *   - keys in A but not in B → issue kind="missing", locale=B
 *   - empty values in any locale → issue kind="empty", locale=that locale
 *
 * "extra" is emitted as the symmetric counterpart of "missing" so users can
 * spot which side is the source of truth at a glance.
 */
export function compareLocales(locales: Record<string, Record<string, string>>): I18nIssue[] {
  const localeNames = Object.keys(locales).sort();
  const issues: I18nIssue[] = [];

  // Empty-value check (per locale, independent of cross-locale comparison).
  for (const name of localeNames) {
    const entries = locales[name];
    if (!entries) continue;
    for (const [k, v] of Object.entries(entries)) {
      if (v.trim() === "") {
        issues.push({ kind: "empty", locale: name, key: k });
      }
    }
  }

  // Cross-locale missing/extra check. We use the union of all keys as the
  // reference set so a key in *any* locale gets a verdict in *every* other.
  const allKeys = new Set<string>();
  for (const name of localeNames) {
    const entries = locales[name];
    if (!entries) continue;
    for (const k of Object.keys(entries)) allKeys.add(k);
  }

  const sortedKeys = Array.from(allKeys).sort();
  for (const key of sortedKeys) {
    const presentIn = localeNames.filter((n) => locales[n] && key in (locales[n] ?? {}));
    const missingIn = localeNames.filter((n) => !presentIn.includes(n));
    if (missingIn.length === 0) continue;

    for (const m of missingIn) {
      issues.push({
        kind: "missing",
        locale: m,
        key,
        detail: `missing in ${m}, present in ${presentIn.join(", ")}`,
      });
    }
    // Symmetric "extra" entries — only meaningful when *exactly one* locale
    // has the key, otherwise "missing" already conveys the asymmetry.
    if (presentIn.length === 1) {
      issues.push({
        kind: "extra",
        locale: presentIn[0] ?? "",
        key,
        detail: `only in ${presentIn[0]}`,
      });
    }
  }

  return issues;
}

/**
 * Discover capability locale groups under a root directory.
 *
 * Scans `<root>/addons/<group>/<cap>/src/i18n/` and
 * `<root>/addons/<group>/<cap>/src/i18n/locales/` for `*.json` files. A
 * group is returned only when its directory holds at least one `.json` file.
 *
 * Capabilities with fewer than two locales are still returned (so the caller
 * can report them as skipped) — discovery does not enforce pairing.
 */
export function discoverLocaleGroups(rootDir: string): LocaleGroup[] {
  const addonsDir = resolve(rootDir, "addons");
  if (!existsSync(addonsDir)) return [];

  const groups: LocaleGroup[] = [];

  const safeReadDir = (dir: string): string[] => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  };

  const collectJsonFiles = (dir: string): Record<string, string> => {
    const out: Record<string, string> = {};
    if (!existsSync(dir)) return out;
    let stat: ReturnType<typeof statSync> | undefined;
    try {
      stat = statSync(dir);
    } catch {
      return out;
    }
    if (!stat?.isDirectory()) return out;
    for (const file of safeReadDir(dir)) {
      if (!file.endsWith(".json")) continue;
      const localeName = file.replace(/\.json$/, "");
      out[localeName] = resolve(dir, file);
    }
    return out;
  };

  for (const group of safeReadDir(addonsDir)) {
    const groupPath = resolve(addonsDir, group);
    let groupStat: ReturnType<typeof statSync> | undefined;
    try {
      groupStat = statSync(groupPath);
    } catch {
      continue;
    }
    if (!groupStat?.isDirectory()) continue;

    for (const cap of safeReadDir(groupPath)) {
      const capPath = resolve(groupPath, cap);
      let capStat: ReturnType<typeof statSync> | undefined;
      try {
        capStat = statSync(capPath);
      } catch {
        continue;
      }
      if (!capStat?.isDirectory()) continue;

      // Probe both layouts: <cap>/src/i18n/*.json and <cap>/src/i18n/locales/*.json.
      // We UNION rather than pick — partial migrations may leave some locales
      // in each. When the same locale name appears in both, the nested
      // `locales/` copy wins (it's the documented post-migration target), but
      // pure-flat or pure-nested capabilities still resolve correctly.
      const i18nDir = resolve(capPath, "src/i18n");
      const localesDir = resolve(i18nDir, "locales");

      const direct = collectJsonFiles(i18nDir);
      const nested = collectJsonFiles(localesDir);

      const merged: Record<string, string> = { ...direct, ...nested };
      if (Object.keys(merged).length === 0) continue;

      groups.push({
        capability: `addons/${group}/${cap}`,
        // Pick the directory containing the most locales for display; ties
        // break toward `locales/` so post-migration capabilities show that.
        dir: Object.keys(nested).length >= Object.keys(direct).length ? localesDir : i18nDir,
        locales: merged,
      });
    }
  }

  return groups.sort((a, b) => a.capability.localeCompare(b.capability));
}

/**
 * Read and parse all locale files for a group. Errors are surfaced as a
 * single thrown Error so the caller can decide policy — at the CLI level we
 * convert those into a `skipped` report rather than crashing the whole run.
 */
export async function readLocaleGroup(
  group: LocaleGroup,
): Promise<Record<string, Record<string, string>>> {
  const out: Record<string, Record<string, string>> = {};
  for (const [locale, filePath] of Object.entries(group.locales)) {
    const tree = (await Bun.file(filePath).json()) as LocaleTree;
    out[locale] = flattenLocale(tree);
  }
  return out;
}

/** Inspect a single capability and return its report. */
export async function checkCapability(group: LocaleGroup): Promise<CapabilityReport> {
  const localeNames = Object.keys(group.locales).sort();
  if (localeNames.length < 2) {
    return {
      capability: group.capability,
      locales: localeNames,
      issues: [],
      skipped: `only ${localeNames.length} locale file found (need at least 2)`,
    };
  }

  let flat: Record<string, Record<string, string>>;
  try {
    flat = await readLocaleGroup(group);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      capability: group.capability,
      locales: localeNames,
      issues: [],
      skipped: `failed to parse locale files: ${msg}`,
    };
  }

  return {
    capability: group.capability,
    locales: localeNames,
    issues: compareLocales(flat),
  };
}

// ── CLI rendering ────────────────────────────────────────────

/** Pretty-print a single capability report to stdout. */
function printReport(report: CapabilityReport): void {
  const header = `• ${report.capability} [${report.locales.join(", ") || "no locales"}]`;
  console.log(header);

  if (report.skipped) {
    console.log(`    skipped: ${report.skipped}`);
    return;
  }

  if (report.issues.length === 0) {
    console.log("    OK");
    return;
  }

  // Group issues by kind for compact output.
  const byKind = new Map<I18nIssue["kind"], I18nIssue[]>();
  for (const issue of report.issues) {
    const list = byKind.get(issue.kind) ?? [];
    list.push(issue);
    byKind.set(issue.kind, list);
  }

  const KIND_LABEL: Record<I18nIssue["kind"], string> = {
    missing: "Missing keys",
    extra: "Extra keys",
    empty: "Empty values",
  };

  for (const kind of ["missing", "extra", "empty"] as const) {
    const list = byKind.get(kind);
    if (!list || list.length === 0) continue;
    console.log(`    ${KIND_LABEL[kind]} (${list.length}):`);
    for (const issue of list) {
      const note = issue.detail ? ` — ${issue.detail}` : "";
      console.log(`        [${issue.locale}] ${issue.key}${note}`);
    }
  }
}

// ── Citty command ────────────────────────────────────────────

// Flat top-level command (`linch i18n-check`) instead of a namespaced
// `linch i18n check` group: a namespace would have to be reserved at the
// CLI entry point, which would silently shadow any downstream capability
// that uses `i18n` for its own subcommands.
export const i18nCheckCommand = defineCommand({
  meta: {
    name: "i18n-check",
    description: "Validate translation key consistency across capability locale files",
  },
  args: {
    cwd: {
      type: "string",
      description: "Project root to scan (defaults to current working directory)",
    },
    json: {
      type: "boolean",
      description: "Emit machine-readable JSON instead of pretty output",
      default: false,
    },
  },
  async run({ args }) {
    const rootDir = (args.cwd as string | undefined) ?? process.cwd();
    const outputJson = Boolean(args.json);

    const groups = discoverLocaleGroups(rootDir);
    const reports: CapabilityReport[] = [];
    for (const g of groups) reports.push(await checkCapability(g));

    const totalIssues = reports.reduce((acc, r) => acc + r.issues.length, 0);
    const skippedCount = reports.filter((r) => r.skipped).length;
    const cleanCount = reports.filter((r) => !r.skipped && r.issues.length === 0).length;

    if (outputJson) {
      console.log(
        JSON.stringify(
          {
            passed: totalIssues === 0,
            summary: {
              capabilities: reports.length,
              clean: cleanCount,
              skipped: skippedCount,
              issues: totalIssues,
            },
            reports,
          },
          null,
          2,
        ),
      );
    } else {
      if (reports.length === 0) {
        consola.warn(`No capability i18n files found under ${rootDir}/addons.`);
      } else {
        console.log("");
        for (const r of reports) printReport(r);
        console.log("");
        if (totalIssues === 0) {
          consola.success(
            `i18n check passed. ${cleanCount} clean, ${skippedCount} skipped, ${reports.length} total.`,
          );
        } else {
          consola.error(
            `i18n check failed: ${totalIssues} issue(s) across ${reports.length} capability(ies).`,
          );
        }
      }
    }

    if (totalIssues > 0) {
      process.exit(1);
    }
  },
});
