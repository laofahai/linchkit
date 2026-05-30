/**
 * Per-capability quality lint (Spec 21 §9.1).
 *
 * A pure, dependency-free checker that validates a single capability
 * directory against three DETERMINISTIC quality gates:
 *
 *  1. Metadata completeness — a valid `capability.json` (preferred) or the
 *     `linchkit` field of `package.json` (fallback), validated with the core
 *     `validateCapabilityMetadata` schema.
 *  2. Core import-boundary — source must only depend on the PUBLIC
 *     `@linchkit/core` barrel, never deep internals (`@linchkit/core/src/...`
 *     or `/dist/...`), nor relative paths that escape into core internals.
 *     Enforces CLAUDE.md: "只依赖 @linchkit/core 的公开 API（不用内部路径）".
 *  3. Test existence — at least one test file must be present (proxy for the
 *     spec's "覆盖率 > 0 / 必须有测试").
 *
 * Filesystem access uses node:fs/node:path only; import scanning is a simple
 * line/regex scan (no TS AST) to match the existing methodology approach.
 *
 * Follow-up: the spec's heuristic "systemPermissions match actual code" scan is
 * intentionally out of scope here (non-deterministic) — track separately.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { validateCapabilityMetadata } from "@linchkit/core";

// -- Types ---------------------------------------------------------------

export interface CapabilityLintIssue {
  /** Which check produced this issue (e.g. "metadata", "import-boundary"). */
  check: string;
  level: "error" | "warning";
  message: string;
  /** Offending file, relative to the capability dir when known. */
  file?: string;
}

export interface CapabilityLintResult {
  /** Absolute capability directory that was linted. */
  dir: string;
  /** True when no error-level issues were found. */
  ok: boolean;
  issues: CapabilityLintIssue[];
}

// -- Entry point ---------------------------------------------------------

/**
 * Lint a single capability directory.
 *
 * @param dir - Path to the capability root (absolute or relative to cwd).
 */
export function lintCapability(dir: string): CapabilityLintResult {
  const root = resolve(dir);
  const issues: CapabilityLintIssue[] = [];

  issues.push(...checkMetadata(root));
  issues.push(...checkImportBoundary(root));
  issues.push(...checkTestExistence(root));

  const hasError = issues.some((i) => i.level === "error");
  return { dir: root, ok: !hasError, issues };
}

// -- Check 1: metadata completeness --------------------------------------

/**
 * Validate the capability manifest. Prefers `capability.json`; falls back to
 * the `linchkit` field of `package.json`.
 */
function checkMetadata(root: string): CapabilityLintIssue[] {
  const issues: CapabilityLintIssue[] = [];

  const capabilityJsonPath = join(root, "capability.json");
  const packageJsonPath = join(root, "package.json");

  let metadata: unknown;
  let sourceFile: string;

  if (existsSync(capabilityJsonPath)) {
    sourceFile = "capability.json";
    const parsed = readJson(capabilityJsonPath);
    if (parsed.error) {
      return [
        {
          check: "metadata",
          level: "error",
          message: `Failed to parse capability.json: ${parsed.error}`,
          file: sourceFile,
        },
      ];
    }
    metadata = parsed.value;
  } else if (existsSync(packageJsonPath)) {
    sourceFile = "package.json";
    const parsed = readJson(packageJsonPath);
    if (parsed.error) {
      return [
        {
          check: "metadata",
          level: "error",
          message: `Failed to parse package.json: ${parsed.error}`,
          file: sourceFile,
        },
      ];
    }
    metadata = metadataFromPackageJson(parsed.value);
  } else {
    return [
      {
        check: "metadata",
        level: "error",
        message: "No capability.json or package.json found in capability directory",
      },
    ];
  }

  const result = validateCapabilityMetadata(metadata);
  if (!result.success) {
    for (const issue of result.errors) {
      const field = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      issues.push({
        check: "metadata",
        level: "error",
        message: `Invalid/missing metadata field "${field}": ${issue.message}`,
        file: sourceFile,
      });
    }
  }

  return issues;
}

/**
 * Build a CapabilityMetadata candidate from a `package.json` object.
 *
 * package.json carries `name`/`version` at the top level and capability fields
 * (`type`, `category`, `label`, ...) under a `linchkit` block. The core schema
 * also has a NESTED `linchkit` compat object (coreVersion/minCoreVersion); the
 * shipped addons store `minCoreVersion` inside the SAME `linchkit` block, so we
 * forward it there. `label` is required by the schema but absent from shipped
 * addon manifests — we pragmatically default it to the package name so a
 * well-formed addon is not falsely flagged; genuinely empty manifests still
 * fail because `type`/`category` will be missing.
 */
function metadataFromPackageJson(pkg: unknown): unknown {
  if (typeof pkg !== "object" || pkg === null) return pkg;
  const record = pkg as Record<string, unknown>;
  const block =
    typeof record.linchkit === "object" && record.linchkit !== null
      ? (record.linchkit as Record<string, unknown>)
      : {};

  const compat: Record<string, unknown> = {};
  if (block.coreVersion !== undefined) compat.coreVersion = block.coreVersion;
  if (block.minVersion !== undefined) compat.minVersion = block.minVersion;
  if (block.minCoreVersion !== undefined) compat.minCoreVersion = block.minCoreVersion;

  const candidate: Record<string, unknown> = {
    name: record.name,
    version: record.version,
    type: block.type,
    category: block.category,
    label: block.label ?? record.name,
  };
  if (block.description !== undefined) candidate.description = block.description;
  else if (record.description !== undefined) candidate.description = record.description;
  if (block.author !== undefined) candidate.author = block.author;
  if (block.dependencies !== undefined) candidate.dependencies = block.dependencies;
  if (Object.keys(compat).length > 0) candidate.linchkit = compat;

  return candidate;
}

// -- Check 2: core import-boundary ---------------------------------------

/**
 * A deep-internal import of @linchkit/core: `@linchkit/core/src/...` or
 * `@linchkit/core/dist/...`. The bare barrel `@linchkit/core` and documented
 * public subpaths (e.g. `@linchkit/core/server`) are NOT matched, so the legit
 * barrel import never trips this rule.
 */
const CORE_INTERNAL_RE = /^@linchkit\/core\/(?:src|dist)(?:\/|$)/;

/**
 * A relative import that escapes the capability root AND references a `core`
 * path — a conservative proxy for reaching into core internals via `../`.
 */
function escapesIntoCoreInternals(filePath: string, capRoot: string, specifier: string): boolean {
  if (!specifier.startsWith(".") || !specifier.includes("..")) return false;
  // Use node:path's dirname so the file's directory is derived correctly on
  // both POSIX ("/") and Windows ("\") separators. A manual lastIndexOf("/")
  // returns -1 on Windows paths and would resolve relative to the CWD instead.
  const fileDir = dirname(filePath);
  const resolved = resolve(fileDir, specifier);
  const rel = relative(capRoot, resolved).replace(/\\/g, "/");
  // Outside the capability root → rel starts with ".."; only flag when the
  // escaping path ALSO points at a `core` segment. Testing `rel` (not the
  // absolute path) avoids false positives when an unrelated ancestor directory
  // happens to be named "core" (e.g. a repo checked out under /…/core/…).
  return rel.startsWith("..") && /(?:^|\/)core(?:\/|$)/.test(rel);
}

function checkImportBoundary(root: string): CapabilityLintIssue[] {
  const issues: CapabilityLintIssue[] = [];
  const srcDir = join(root, "src");
  if (!existsSync(srcDir)) return issues;

  for (const file of collectSourceFiles(srcDir)) {
    const content = readFileSync(file, "utf-8");
    const relFile = relative(root, file).replace(/\\/g, "/");

    for (const specifier of extractImportSpecifiers(content)) {
      if (CORE_INTERNAL_RE.test(specifier)) {
        issues.push({
          check: "import-boundary",
          level: "error",
          message: `Forbidden deep import of @linchkit/core internals: "${specifier}". Use the public "@linchkit/core" barrel only.`,
          file: relFile,
        });
      } else if (escapesIntoCoreInternals(file, root, specifier)) {
        issues.push({
          check: "import-boundary",
          level: "error",
          message: `Relative import "${specifier}" escapes the capability root into core internals. Import from the public "@linchkit/core" barrel instead.`,
          file: relFile,
        });
      }
    }
  }

  return issues;
}

// -- Check 3: test existence ---------------------------------------------

const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx)$/;

function checkTestExistence(root: string): CapabilityLintIssue[] {
  if (hasTestFile(root)) return [];
  return [
    {
      check: "test-existence",
      level: "error",
      message:
        "No test file found. A capability must contain at least one *.test.ts(x), *.spec.ts, or a __tests__/ test (Spec 21 §9.1).",
    },
  ];
}

function hasTestFile(dir: string): boolean {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }

  for (const entry of entries) {
    const full = join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      if (isIgnoredDir(entry)) continue;
      if (hasTestFile(full)) return true;
    } else if (TEST_FILE_RE.test(entry)) {
      return true;
    }
  }
  return false;
}

// -- Filesystem helpers --------------------------------------------------

const SOURCE_FILE_RE = /\.(ts|tsx)$/;

/** Collect all `.ts`/`.tsx` files under a directory (recursively). */
function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      if (isIgnoredDir(entry)) continue;
      out.push(...collectSourceFiles(full));
    } else if (SOURCE_FILE_RE.test(entry) && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

function isIgnoredDir(name: string): boolean {
  return name === "node_modules" || name === "dist" || name === ".git";
}

/**
 * Strip comments from source so the import-specifier regexes never match a
 * path that only appears in commented-out code or prose (e.g. a JSDoc block
 * that mentions `@linchkit/core/src/...`, as THIS file's own header does).
 *
 * Dependency-free, no AST:
 *  - Block comments (including multi-line) are removed via `[\s\S]*?`.
 *  - Line comments are removed to end of line, BUT a `//` immediately preceded
 *    by `:` is left intact so URLs inside strings (`https://...`) are not
 *    mistaken for the start of a comment.
 *
 * It is intentionally applied to the FULL content (not per-line), so the
 * existing full-content regexes still span newlines for multi-line imports.
 */
function stripComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * Extract every module specifier referenced by `import`/`export ... from` and
 * `require("...")` calls. A plain line/regex scan — sufficient and dependency
 * free, matching the existing methodology checkers. Comments are stripped first
 * so commented-out imports and prose are not false-positives.
 */
function extractImportSpecifiers(content: string): string[] {
  const code = stripComments(content);
  const specifiers: string[] = [];
  const fromRe = /(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/g;
  const sideEffectRe = /\bimport\s+["']([^"']+)["']/g;
  const requireRe = /\brequire\(\s*["']([^"']+)["']\s*\)/g;
  const dynamicImportRe = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

  for (const re of [fromRe, sideEffectRe, requireRe, dynamicImportRe]) {
    for (const m of code.matchAll(re)) {
      if (m[1]) specifiers.push(m[1]);
    }
  }
  return specifiers;
}

/** Parse JSON from disk, returning either the value or a string error. */
function readJson(path: string): { value?: unknown; error?: string } {
  try {
    return { value: JSON.parse(readFileSync(path, "utf-8")) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
