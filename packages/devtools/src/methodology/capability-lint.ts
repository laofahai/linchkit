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
 *  3. Test existence — at least one test file must be present AND contain at
 *     least one executable test (`test(`/`it(`/`describe(`/`Bun.test(`); an
 *     empty or assertion-less stub fails (proxy for the spec's "覆盖率 > 0 /
 *     必须有测试").
 *  4. Core version declaration consistency — `@linchkit/core` must be a
 *     peerDependency and a core-version range must be declared (`coreVersion`,
 *     preferred over the deprecated `minCoreVersion`); when the peerDep pins a
 *     concrete range it must equal the declared core version (Spec 21 §10.1).
 *     Additionally, when the local `@linchkit/core` version can be resolved, the
 *     declared range (and any concrete peerDep range) MUST satisfy it — a range
 *     that excludes the only core version that exists is a skew bug. Version
 *     resolution is best-effort: if it cannot be determined, the satisfaction
 *     check is skipped silently.
 *
 * Filesystem access uses node:fs/node:path only; import scanning is a simple
 * line/regex scan (no TS AST) to match the existing methodology approach.
 *
 * Follow-up: the spec's heuristic "systemPermissions match actual code" scan is
 * intentionally out of scope here (non-deterministic) — track separately.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { satisfiesVersionRange, validateCapabilityMetadata } from "@linchkit/core";

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
  issues.push(...checkCoreVersion(root));

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

// -- Check 3: test existence + executable test ---------------------------

const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx)$/;

/**
 * Detects a call to a Bun/Jest-style test runner: `test(`, `it(`, `describe(`,
 * their `.only`/`.skip`/`.each` member forms (`test.`/`it.`/`describe.`), or
 * the explicit `Bun.test(`. Run AFTER `stripComments`, so a commented-out test
 * never counts. The `\b` anchor avoids matching identifiers like `submit(` or
 * `unit(`.
 */
// Match an executable test call: `test(` / `it(` / `describe(` / `Bun.test(`,
// or a member call like `test.only(` / `it.each(`. Requiring the trailing `(`
// after a `.member` avoids false positives on strings/paths such as
// `"test.ts"` or `"./test.helper"` (stripComments preserves string contents).
const EXECUTABLE_TEST_RE = /\b(?:Bun\.test\s*\(|(?:test|it|describe)\s*(?:\(|\.\s*\w+\s*\())/;

function checkTestExistence(root: string): CapabilityLintIssue[] {
  const testFiles = collectTestFiles(root);
  if (testFiles.length === 0) {
    return [
      {
        check: "test-existence",
        level: "error",
        message:
          "No test file found. A capability must contain at least one *.test.ts(x), *.spec.ts, or a __tests__/ test (Spec 21 §9.1).",
      },
    ];
  }

  const hasExecutableTest = testFiles.some((file) => {
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      return false;
    }
    return EXECUTABLE_TEST_RE.test(stripComments(content));
  });

  if (!hasExecutableTest) {
    return [
      {
        check: "test-existence",
        level: "error",
        message:
          "Test file(s) found but none contain an executable test (test(...)/it(...)/describe(...)). An empty or stub test does not satisfy coverage > 0 (Spec 21 §9.1).",
      },
    ];
  }

  return [];
}

/** Collect all `*.test.ts(x)` / `*.spec.ts(x)` files under a directory. */
function collectTestFiles(dir: string): string[] {
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
      out.push(...collectTestFiles(full));
    } else if (TEST_FILE_RE.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

// -- Check 4: core version declaration consistency -----------------------

/**
 * A `workspace:` protocol specifier used inside the monorepo (e.g.
 * `workspace:*`). Such peerDeps resolve to the local core at build time, so we
 * cannot compare them against a published semver range — the equality check is
 * skipped and only presence of a declared `coreVersion` is required.
 */
const WORKSPACE_PROTOCOL_RE = /^workspace:/;

/**
 * Validate the @linchkit/core version contract (Spec 21 §10.1):
 *  - `@linchkit/core` MUST be declared in `peerDependencies` → error if absent.
 *  - A core-version range MUST be declared: `capability.json` `coreVersion`
 *    (precedence) else `package.json` `linchkit.coreVersion`. If only the
 *    deprecated `linchkit.minCoreVersion` is present it is accepted with a
 *    WARNING recommending migration; if none present → error.
 *  - When the peerDep is a concrete semver range AND a coreVersion is declared,
 *    they MUST be equal → error on mismatch. A `workspace:*` peerDep skips the
 *    equality check (only presence of a coreVersion is required).
 *  - When the local `@linchkit/core` version is resolvable, the declared
 *    `coreVersion` range (and any concrete peerDep range) MUST SATISFY it →
 *    error otherwise. This catches a range that excludes the only core version
 *    that exists (e.g. `>=0.3.0 <0.4.0` against a published 0.2.0). The check is
 *    best-effort: if the local core version cannot be resolved it is skipped
 *    silently (e.g. when a capability is linted standalone outside the monorepo).
 */
function checkCoreVersion(root: string): CapabilityLintIssue[] {
  const issues: CapabilityLintIssue[] = [];

  const packageJsonPath = join(root, "package.json");
  if (!existsSync(packageJsonPath)) {
    // No package.json at all — there is no peerDependencies block to inspect.
    // The metadata check already reports the missing manifest; surface the core
    // contract failure here too so this check is self-contained.
    return [
      {
        check: "core-version",
        level: "error",
        message:
          'No package.json found, so "@linchkit/core" cannot be declared in peerDependencies (Spec 21 §10.1).',
        file: "package.json",
      },
    ];
  }

  const pkgParsed = readJson(packageJsonPath);
  if (pkgParsed.error || typeof pkgParsed.value !== "object" || pkgParsed.value === null) {
    return [
      {
        check: "core-version",
        level: "error",
        message: `Failed to parse package.json for core-version check: ${pkgParsed.error ?? "not an object"}`,
        file: "package.json",
      },
    ];
  }
  const pkg = pkgParsed.value as Record<string, unknown>;

  // 1. peerDependencies["@linchkit/core"] must be present.
  const peerDeps =
    typeof pkg.peerDependencies === "object" && pkg.peerDependencies !== null
      ? (pkg.peerDependencies as Record<string, unknown>)
      : {};
  const peerCore = peerDeps["@linchkit/core"];
  if (typeof peerCore !== "string" || peerCore.length === 0) {
    issues.push({
      check: "core-version",
      level: "error",
      message:
        '"@linchkit/core" must be declared in package.json "peerDependencies" (Spec 21 §10.1).',
      file: "package.json",
    });
  }

  // 2. A core-version range must be declared. capability.json.coreVersion takes
  //    precedence over package.json.linchkit.coreVersion; the deprecated
  //    minCoreVersion is accepted as a fallback (with a warning).
  const declared = resolveDeclaredCoreVersion(root, pkg);
  if (declared.coreVersion === undefined && declared.minCoreVersion === undefined) {
    issues.push({
      check: "core-version",
      level: "error",
      message:
        'No core-version range declared. Add "coreVersion" to capability.json or package.json "linchkit" (Spec 21 §10.1).',
      file: declared.sourceFile,
    });
    return issues;
  }

  let effectiveRange: string;
  if (declared.coreVersion !== undefined) {
    effectiveRange = declared.coreVersion;
  } else {
    // Only the deprecated minCoreVersion is present — accept with a warning.
    // (declared.minCoreVersion is defined here per the guard above.)
    effectiveRange = declared.minCoreVersion as string;
    issues.push({
      check: "core-version",
      level: "warning",
      message:
        'Deprecated "minCoreVersion" used. Migrate to "coreVersion" (a semver range) — minCoreVersion is @deprecated (Spec 21 §10.1).',
      file: declared.sourceFile,
    });
  }

  // 3. Equality check — only when the peerDep is a concrete range. workspace:*
  //    resolves locally and cannot be compared, so it is skipped.
  const peerIsConcrete =
    typeof peerCore === "string" && peerCore.length > 0 && !WORKSPACE_PROTOCOL_RE.test(peerCore);
  if (peerIsConcrete) {
    if (peerCore !== effectiveRange) {
      issues.push({
        check: "core-version",
        level: "error",
        message: `Core-version mismatch: peerDependencies["@linchkit/core"] is "${peerCore}" but the declared coreVersion is "${effectiveRange}". They must be equal (Spec 21 §10.1).`,
        file: "package.json",
      });
    }
  }

  // 4. Satisfaction check — best-effort. When the local @linchkit/core version
  //    is resolvable, every declared SEMVER range MUST satisfy it; a range that
  //    excludes the only core version that exists is a skew bug (Spec 21 §10.1).
  //    A `workspace:*` range resolves locally and is not a comparable semver, so
  //    it is skipped (mirrors the equality check). If the version cannot be
  //    resolved (e.g. linted standalone outside the monorepo), skip silently —
  //    never throw, never fail the lint on resolution failure.
  const localCoreVersion = resolveLocalCoreVersion(root);
  if (localCoreVersion !== undefined) {
    // Check the declared coreVersion/minCoreVersion range unless it is a
    // non-semver workspace protocol specifier.
    if (
      !WORKSPACE_PROTOCOL_RE.test(effectiveRange) &&
      !safeSatisfies(localCoreVersion, effectiveRange)
    ) {
      issues.push({
        check: "core-version",
        level: "error",
        message: `Declared coreVersion range "${effectiveRange}" does not satisfy the current @linchkit/core version "${localCoreVersion}". Update the range to include it (Spec 21 §10.1).`,
        file: "package.json",
      });
    }
    // Also check the concrete peerDep range. When it equals the declared range
    // (the common case) the check above already covered it, so only emit a
    // distinct issue when the peerDep range differs and itself fails.
    if (
      peerIsConcrete &&
      peerCore !== effectiveRange &&
      !safeSatisfies(localCoreVersion, peerCore)
    ) {
      issues.push({
        check: "core-version",
        level: "error",
        message: `peerDependencies["@linchkit/core"] range "${peerCore}" does not satisfy the current @linchkit/core version "${localCoreVersion}". Update the range to include it (Spec 21 §10.1).`,
        file: "package.json",
      });
    }
  }

  return issues;
}

/**
 * Apply {@link satisfiesVersionRange} defensively. A malformed range must never
 * crash the lint; on any thrown error treat the range as NON-satisfying is too
 * aggressive (it would flag a clean addon on a parser quirk), so a throw is
 * treated as "cannot determine" → satisfied (no error). This keeps the check
 * best-effort and false-positive-averse.
 */
function safeSatisfies(version: string, range: string): boolean {
  try {
    return satisfiesVersionRange(version, range);
  } catch {
    return true;
  }
}

/**
 * Resolve the concrete local `@linchkit/core` version (e.g. "0.2.0"), best-effort.
 *
 * Strategy (in order):
 *  1. Walk up from the capability dir to the monorepo root — the nearest ancestor
 *     containing `packages/core/package.json` — and read its `.version`. This is
 *     the authoritative source when the lint runs on an in-repo capability.
 *  2. Fall back to Node-style module resolution of `@linchkit/core/package.json`
 *     from the capability dir (handles a capability installed against a published
 *     core outside the monorepo).
 *
 * Returns `undefined` when neither yields a usable version string. Never throws.
 */
function resolveLocalCoreVersion(root: string): string | undefined {
  // 1. Walk up to the monorepo root (dir with packages/core/package.json).
  let dir = root;
  // Bound the walk by directory depth; resolve("/", "..") === "/" terminates it.
  for (let i = 0; i < 64; i++) {
    const candidate = join(dir, "packages", "core", "package.json");
    if (existsSync(candidate)) {
      const v = readVersionField(candidate);
      if (v !== undefined) return v;
    }
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }

  // 2. Fall back to Node-style module resolution of the installed @linchkit/core
  //    manifest, anchored at the capability dir. Handles a capability installed
  //    against a published core outside the monorepo.
  try {
    const req = createRequire(join(root, "package.json"));
    const pkgPath = req.resolve("@linchkit/core/package.json");
    const v = readVersionField(pkgPath);
    if (v !== undefined) return v;
  } catch {
    // Module not resolvable from here — fall through to undefined.
  }

  return undefined;
}

/** Read and return the `.version` string field of a package.json, or undefined. */
function readVersionField(packageJsonPath: string): string | undefined {
  const parsed = readJson(packageJsonPath);
  if (parsed.error || typeof parsed.value !== "object" || parsed.value === null) {
    return undefined;
  }
  const version = (parsed.value as Record<string, unknown>).version;
  return typeof version === "string" && version.length > 0 ? version : undefined;
}

interface DeclaredCoreVersion {
  /** Resolved `coreVersion` range (capability.json precedence), if any. */
  coreVersion?: string;
  /** Deprecated `linchkit.minCoreVersion` from package.json, if any. */
  minCoreVersion?: string;
  /** File the declaration came from, for issue attribution. */
  sourceFile: string;
}

/**
 * Resolve the declared core-version range. `capability.json` `coreVersion`
 * wins; otherwise fall back to `package.json` `linchkit.coreVersion`, then the
 * deprecated `package.json` `linchkit.minCoreVersion`.
 */
function resolveDeclaredCoreVersion(
  root: string,
  pkg: Record<string, unknown>,
): DeclaredCoreVersion {
  const capabilityJsonPath = join(root, "capability.json");
  if (existsSync(capabilityJsonPath)) {
    const parsed = readJson(capabilityJsonPath);
    if (!parsed.error && typeof parsed.value === "object" && parsed.value !== null) {
      const capObj = parsed.value as Record<string, unknown>;
      // capabilityMetadataSchema nests the compat fields under `linchkit`
      // (linchkit.coreVersion / linchkit.minCoreVersion). Read the nested block
      // first; accept a top-level value as a backward-compatible fallback.
      const capBlock =
        typeof capObj.linchkit === "object" && capObj.linchkit !== null
          ? (capObj.linchkit as Record<string, unknown>)
          : {};
      const cv = capBlock.coreVersion ?? capObj.coreVersion;
      if (typeof cv === "string" && cv.length > 0) {
        return { coreVersion: cv, sourceFile: "capability.json" };
      }
      const capMin = capBlock.minCoreVersion ?? capObj.minCoreVersion;
      if (typeof capMin === "string" && capMin.length > 0) {
        return { minCoreVersion: capMin, sourceFile: "capability.json" };
      }
    }
  }

  const block =
    typeof pkg.linchkit === "object" && pkg.linchkit !== null
      ? (pkg.linchkit as Record<string, unknown>)
      : {};
  const cv = block.coreVersion;
  if (typeof cv === "string" && cv.length > 0) {
    return { coreVersion: cv, sourceFile: "package.json" };
  }
  const min = block.minCoreVersion;
  if (typeof min === "string" && min.length > 0) {
    return { minCoreVersion: min, sourceFile: "package.json" };
  }

  return { sourceFile: existsSync(capabilityJsonPath) ? "capability.json" : "package.json" };
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
 * Dependency-free, no AST: a single-pass character-scan tokenizer walks the
 * source one char at a time, tracking which lexical region it is inside, and:
 *  - Removes `// ...` line comments (to end of line) and `/* ... *​/` block
 *    comments (including multi-line). A block comment is replaced with a single
 *    space so a multi-line import split across a removed block still parses
 *    (e.g. `import /* x *​/ { a } from "..."`); line comments are
 *    dropped entirely up to (but not including) their newline.
 *  - Preserves the FULL contents of single-quoted strings, double-quoted
 *    strings, template literals, and regex literals — including any `//`,
 *    `/*`, quotes, or backslashes inside them — so a `//` in `"a // b"` or a
 *    URL like `https://...` is never mistaken for a comment.
 *  - Honours escape sequences inside strings/regex (`\"`, `\'`, `\\`, `\/`,
 *    `` \` ``) so an escaped delimiter does not prematurely end the literal.
 *
 * Regex-vs-division heuristic: a `/` starts a regex literal only when the
 * previous SIGNIFICANT (non-whitespace, non-comment) character cannot end an
 * expression — i.e. it is one of `= ( , [ { ; : ! & | ? + - * / % < > ^ ~`, or
 * the start of input, or the tail of a regex-permitting keyword (`return`,
 * `typeof`, `case`, `in`, `of`, `do`, `else`, `yield`, `void`, `delete`,
 * `instanceof`, `new`). Otherwise `/` is treated as the division operator, so
 * `a / b // c` strips the `// c`, and `a / b / c` is left alone. This is a
 * pragmatic heuristic, NOT a full JS lexer; its known limits are: it does not
 * track whether a keyword is used as an identifier (`const of = 1; of /2/`
 * would be misread), and it treats template literals as opaque from backtick to
 * backtick — it does NOT recurse into `${...}` interpolation. Both are
 * acceptable here because import specifiers never live inside `${}` and the
 * tokenizer only ever runs to gate import-path extraction; the worst case is a
 * harmless false negative (a real import dropped), never a false positive.
 *
 * It is intentionally applied to the FULL content (not per-line), so the
 * downstream regexes still span newlines for multi-line imports.
 *
 * Exported (not via the package's public index) so the tokenizer can be unit
 * tested directly; it remains an internal helper.
 */
export function stripComments(content: string): string {
  let out = "";
  let i = 0;
  const n = content.length;
  // Last significant emitted char, used by the regex-vs-division heuristic.
  let prevSignificant = "";

  // Keywords whose presence right before `/` means a regex literal follows.
  const regexKeywords = new Set([
    "return",
    "throw",
    "default",
    "typeof",
    "case",
    "in",
    "of",
    "do",
    "else",
    "yield",
    "void",
    "delete",
    "instanceof",
    "new",
  ]);

  const isExprEndChar = (c: string): boolean =>
    // A char can end an expression (so a following `/` is division) unless it is
    // a punctuator that permits a regex. Testing the punctuator set by exclusion
    // also handles Unicode identifiers, not just ASCII `\w` chars.
    !/[=,({[;:!&|?+\-*/%<>^~]/.test(c);

  /** Decide whether a `/` at the current position begins a regex literal. */
  const slashStartsRegex = (): boolean => {
    if (prevSignificant === "") return true; // start of input
    if (isExprEndChar(prevSignificant)) {
      // Could still be a regex if the trailing word is a regex-permitting
      // keyword (e.g. `return /x/`). Re-read the word ending at this point.
      if (/[\w$]/.test(prevSignificant)) {
        // Re-read the trailing identifier, skipping any whitespace already
        // emitted between it and this `/` (e.g. `out` ends with `"return "`).
        const word = out.match(/([\w$]+)\s*$/)?.[1] ?? "";
        return regexKeywords.has(word);
      }
      return false;
    }
    return true; // punctuator like = ( , [ { ; : etc. → regex
  };

  while (i < n) {
    // `i < n` guarantees an in-bounds char; the `?? ""` keeps the type `string`
    // under `noUncheckedIndexedAccess` without an assertion. `next` may be the
    // out-of-bounds slot, so it stays `string | undefined`.
    const ch = content[i] ?? "";
    const next = content[i + 1];

    // -- Block comment: /* ... */ → single space ------------------------
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(content[i] === "*" && content[i + 1] === "/")) i++;
      i += 2; // skip closing */ (clamped by loop bound on the next pass)
      // A comment is "non-significant": leave `prevSignificant` untouched so the
      // regex-vs-division heuristic keeps seeing the real char before the comment
      // (e.g. `a /* c */ / b` stays division; `= /* c */ /re/` stays regex). The
      // emitted space only keeps tokens apart for the downstream import regexes.
      out += " ";
      continue;
    }

    // -- Line comment: // ... → dropped to end of line ------------------
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < n && content[i] !== "\n") i++;
      // Leave the newline (if any) for the next iteration to emit.
      continue;
    }

    // -- String literal: '...' or "..." ---------------------------------
    if (ch === '"' || ch === "'") {
      const quote = ch;
      out += ch;
      i++;
      while (i < n) {
        const c = content[i];
        out += c;
        if (c === "\\") {
          // Emit the escaped char verbatim and skip it.
          if (i + 1 < n) out += content[i + 1];
          i += 2;
          continue;
        }
        i++;
        if (c === quote) break;
        if (c === "\n") break; // unterminated string — stop at newline
      }
      prevSignificant = quote;
      continue;
    }

    // -- Template literal: `...` (opaque, no ${} recursion) -------------
    if (ch === "`") {
      out += ch;
      i++;
      while (i < n) {
        const c = content[i];
        out += c;
        if (c === "\\") {
          if (i + 1 < n) out += content[i + 1];
          i += 2;
          continue;
        }
        i++;
        if (c === "`") break;
      }
      prevSignificant = "`";
      continue;
    }

    // -- Regex literal: /.../ flags -------------------------------------
    if (ch === "/" && slashStartsRegex()) {
      out += ch;
      i++;
      let inClass = false; // inside a [...] character class
      while (i < n) {
        const c = content[i];
        out += c;
        if (c === "\\") {
          if (i + 1 < n) out += content[i + 1];
          i += 2;
          continue;
        }
        i++;
        if (c === "\n") break; // unterminated regex — bail at newline
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) break; // regex body ends
      }
      // Consume trailing flags (a-z) so a `/g` etc. is preserved verbatim.
      while (i < n && /[a-z]/i.test(content[i] ?? "")) {
        out += content[i];
        i++;
      }
      prevSignificant = "/";
      continue;
    }

    // -- Ordinary character ---------------------------------------------
    out += ch;
    i++;
    if (!/\s/.test(ch)) prevSignificant = ch;
  }

  return out;
}

/**
 * Extract every module specifier referenced by `import`/`export ... from` and
 * `require("...")` calls. A plain line/regex scan — sufficient and dependency
 * free, matching the existing methodology checkers. Comments are stripped first
 * so commented-out imports and prose are not false-positives.
 *
 * Exported (not via the package's public index) so it can be unit tested
 * directly; it remains an internal helper.
 */
export function extractImportSpecifiers(content: string): string[] {
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
