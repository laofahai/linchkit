/**
 * Project structure validation.
 *
 * Checks that directories follow LinchKit conventions, capability packages
 * have the expected layout, and files use kebab-case naming.
 */

import type { QualityIssue, QualityReport } from "./code-quality";

// ── Types ───────────────────────────────────────────────

export interface DirectoryEntry {
  /** Relative path from root (e.g., "src/types") */
  path: string;
  /** Whether the entry is a directory */
  isDirectory: boolean;
}

export interface StructureExpectation {
  /** Directory that must exist (relative path) */
  path: string;
  /** Whether the directory is required (default: true) */
  required?: boolean;
  /** Human-readable description */
  description?: string;
}

// ── Default expectations ────────────────────────────────

const DEFAULT_PACKAGE_DIRS: StructureExpectation[] = [
  { path: "src", required: true, description: "Source code directory" },
  { path: "src/types", required: false, description: "Type definitions" },
  { path: "__tests__", required: false, description: "Test directory" },
];

const CAPABILITY_REQUIRED_DIRS: StructureExpectation[] = [
  { path: "src", required: true, description: "Source code directory" },
  { path: "src/schemas", required: false, description: "Schema definitions" },
  { path: "package.json", required: true, description: "Package manifest" },
];

const CAPABILITY_EXPECTED_FILES = [{ pattern: "src/index.ts", description: "Main entry point" }];

// ── Project structure validation ────────────────────────

/**
 * Validate that a package directory has the expected structure.
 *
 * @param rootDir - Root directory path
 * @param entries - Directory listing
 * @param expectations - Expected directories (defaults to standard package layout)
 */
export function validateProjectStructure(
  rootDir: string,
  entries: DirectoryEntry[],
  expectations?: StructureExpectation[],
): QualityReport {
  const issues: QualityIssue[] = [];
  const expected = expectations ?? DEFAULT_PACKAGE_DIRS;
  const existingPaths = new Set(entries.map((e) => e.path));

  for (const exp of expected) {
    const isRequired = exp.required !== false;
    if (!existingPaths.has(exp.path)) {
      issues.push({
        severity: isRequired ? "error" : "info",
        rule: "project-structure",
        message: isRequired
          ? `Required directory "${exp.path}" is missing in ${rootDir}`
          : `Recommended directory "${exp.path}" is missing in ${rootDir} (${exp.description})`,
        file: rootDir,
      });
    }
  }

  return buildReport(issues);
}

// ── Capability structure validation ─────────────────────

/**
 * Validate that a capability directory follows conventions.
 *
 * Checks:
 * - Required dirs/files exist (src/, package.json)
 * - Entry point exists (src/index.ts)
 * - Directory name uses kebab-case with `cap-` prefix
 */
export function validateCapabilityStructure(
  capDir: string,
  entries: DirectoryEntry[],
): QualityReport {
  const issues: QualityIssue[] = [];
  const existingPaths = new Set(entries.map((e) => e.path));

  // Check capability naming convention (cap- prefix, kebab-case)
  const dirName = capDir.split("/").filter(Boolean).pop() ?? "";
  if (!dirName.startsWith("cap-")) {
    issues.push({
      severity: "warning",
      rule: "capability-naming",
      message: `Capability directory "${dirName}" should use "cap-" prefix`,
      file: capDir,
    });
  }

  const KEBAB_CASE_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
  if (!KEBAB_CASE_RE.test(dirName)) {
    issues.push({
      severity: "warning",
      rule: "capability-naming",
      message: `Capability directory "${dirName}" should use kebab-case`,
      file: capDir,
    });
  }

  // Check required structure
  for (const exp of CAPABILITY_REQUIRED_DIRS) {
    const isRequired = exp.required !== false;
    if (!existingPaths.has(exp.path)) {
      issues.push({
        severity: isRequired ? "error" : "info",
        rule: "capability-structure",
        message: `${isRequired ? "Required" : "Recommended"} path "${exp.path}" is missing in capability ${dirName}`,
        file: capDir,
      });
    }
  }

  // Check expected files
  for (const ef of CAPABILITY_EXPECTED_FILES) {
    if (!existingPaths.has(ef.pattern)) {
      issues.push({
        severity: "warning",
        rule: "capability-structure",
        message: `Expected file "${ef.pattern}" not found in capability ${dirName} (${ef.description})`,
        file: capDir,
      });
    }
  }

  return buildReport(issues);
}

// ── File naming validation ──────────────────────────────

const KEBAB_CASE_FILE_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/**
 * Ensure files follow the expected naming convention.
 *
 * @param pattern - Naming pattern to enforce ("kebab-case" is the default and only supported pattern)
 * @param files - File paths to check
 */
export function checkFileNaming(pattern: "kebab-case", files: string[]): QualityReport {
  const issues: QualityIssue[] = [];

  for (const filePath of files) {
    const segments = filePath.replace(/\\/g, "/").split("/");
    const fileName = segments[segments.length - 1];
    if (!fileName) continue;

    // Skip dotfiles, index files, declaration files, test files
    if (fileName.startsWith(".") || fileName.startsWith("_")) continue;

    const baseName = fileName
      .replace(/\.(test|spec)\.(ts|tsx|js|jsx)$/, "")
      .replace(/\.(ts|tsx|js|jsx)$/, "")
      .replace(/\.d$/, "");

    if (baseName === "index") continue;

    if (pattern === "kebab-case" && !KEBAB_CASE_FILE_RE.test(baseName)) {
      issues.push({
        severity: "warning",
        rule: "file-naming",
        message: `File "${fileName}" does not follow kebab-case convention`,
        file: filePath,
      });
    }
  }

  return buildReport(issues);
}

// ── Helpers ─────────────────────────────────────────────

function buildReport(issues: QualityIssue[]): QualityReport {
  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.filter((i) => i.severity === "warning").length;
  const infos = issues.filter((i) => i.severity === "info").length;

  return {
    issues,
    passed: errors === 0,
    summary: { errors, warnings, infos },
  };
}
