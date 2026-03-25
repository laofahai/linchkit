/**
 * Code quality checks and conventions enforcement.
 *
 * Validates naming conventions, import patterns, and export boundaries
 * for LinchKit projects.
 */

// ── Types ───────────────────────────────────────────────

export type Severity = "error" | "warning" | "info";

export interface QualityIssue {
  severity: Severity;
  rule: string;
  message: string;
  file?: string;
  line?: number;
}

export interface QualityReport {
  issues: QualityIssue[];
  passed: boolean;
  summary: {
    errors: number;
    warnings: number;
    infos: number;
  };
}

export interface FileContent {
  path: string;
  content: string;
}

export interface ExportBoundaryConfig {
  /** Entry point file path */
  entryPoint: string;
  /** Whether this entry point is browser-safe */
  browserSafe: boolean;
  /** Patterns that should NOT appear in browser-safe entry points */
  serverOnlyPatterns?: string[];
}

// ── Naming conventions ──────────────────────────────────

const KEBAB_CASE_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const CAMEL_CASE_RE = /^[a-z][a-zA-Z0-9]*$/;
const PASCAL_CASE_RE = /^[A-Z][a-zA-Z0-9]*$/;
const UPPER_SNAKE_RE = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/;

/**
 * Validate file and symbol naming conventions.
 *
 * Rules enforced:
 * - TypeScript files: kebab-case (e.g., `my-module.ts`)
 * - Functions/variables: camelCase
 * - Classes/interfaces/types: PascalCase
 * - Constants: UPPER_SNAKE_CASE or camelCase (both accepted)
 */
export function validateNamingConventions(files: FileContent[]): QualityReport {
  const issues: QualityIssue[] = [];

  for (const file of files) {
    // Check file naming (kebab-case for .ts files)
    const fileName = extractFileName(file.path);
    if (
      fileName &&
      !fileName.startsWith("_") &&
      !isTestFile(fileName) &&
      !isDeclarationFile(fileName)
    ) {
      const baseName = fileName.replace(/\.(ts|tsx|js|jsx)$/, "");
      if (baseName !== "index" && !KEBAB_CASE_RE.test(baseName)) {
        issues.push({
          severity: "warning",
          rule: "file-naming",
          message: `File "${fileName}" should use kebab-case naming`,
          file: file.path,
        });
      }
    }

    // Check exported function names (camelCase)
    const funcMatches = file.content.matchAll(
      /export\s+(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)/g,
    );
    for (const m of funcMatches) {
      const name = m[1] as string;
      if (!CAMEL_CASE_RE.test(name)) {
        issues.push({
          severity: "warning",
          rule: "function-naming",
          message: `Exported function "${name}" should use camelCase`,
          file: file.path,
          line: lineNumber(file.content, m.index ?? 0),
        });
      }
    }

    // Check exported class names (PascalCase)
    const classMatches = file.content.matchAll(/export\s+class\s+([a-zA-Z_$][\w$]*)/g);
    for (const m of classMatches) {
      const name = m[1] as string;
      if (!PASCAL_CASE_RE.test(name)) {
        issues.push({
          severity: "error",
          rule: "class-naming",
          message: `Exported class "${name}" should use PascalCase`,
          file: file.path,
          line: lineNumber(file.content, m.index ?? 0),
        });
      }
    }

    // Check exported interface/type names (PascalCase)
    const typeMatches = file.content.matchAll(/export\s+(?:interface|type)\s+([a-zA-Z_$][\w$]*)/g);
    for (const m of typeMatches) {
      const name = m[1] as string;
      if (!PASCAL_CASE_RE.test(name)) {
        issues.push({
          severity: "error",
          rule: "type-naming",
          message: `Exported type/interface "${name}" should use PascalCase`,
          file: file.path,
          line: lineNumber(file.content, m.index ?? 0),
        });
      }
    }

    // Check exported const naming (UPPER_SNAKE or camelCase)
    const constMatches = file.content.matchAll(/export\s+const\s+([a-zA-Z_$][\w$]*)/g);
    for (const m of constMatches) {
      const name = m[1] as string;
      if (!CAMEL_CASE_RE.test(name) && !UPPER_SNAKE_RE.test(name) && !PASCAL_CASE_RE.test(name)) {
        issues.push({
          severity: "warning",
          rule: "const-naming",
          message: `Exported const "${name}" should use camelCase, PascalCase, or UPPER_SNAKE_CASE`,
          file: file.path,
          line: lineNumber(file.content, m.index ?? 0),
        });
      }
    }
  }

  return buildReport(issues);
}

// ── Import patterns ─────────────────────────────────────

/**
 * Validate import ordering and detect potential circular dependencies.
 *
 * Import order: external packages → absolute internal → relative
 * Circular dependency detection: looks for import cycles within provided files.
 */
export function checkImportPatterns(files: FileContent[]): QualityReport {
  const issues: QualityIssue[] = [];
  const importGraph = new Map<string, Set<string>>();

  for (const file of files) {
    const imports = extractImports(file.content);
    const deps = new Set<string>();

    let lastCategory: "external" | "internal" | "relative" | null = null;

    for (const imp of imports) {
      const category = categorizeImport(imp.source);

      // Check ordering: external → internal → relative
      if (lastCategory && isOutOfOrder(lastCategory, category)) {
        issues.push({
          severity: "warning",
          rule: "import-order",
          message: `Import "${imp.source}" is out of order. Expected: external → internal → relative`,
          file: file.path,
          line: imp.line,
        });
      }
      lastCategory = category;

      // Build dependency graph for relative imports
      if (category === "relative") {
        const resolved = resolveRelativeImport(file.path, imp.source);
        if (resolved) {
          deps.add(resolved);
        }
      }
    }

    importGraph.set(normalizePath(file.path), deps);
  }

  // Detect circular dependencies
  const cycles = detectCycles(importGraph);
  for (const cycle of cycles) {
    issues.push({
      severity: "error",
      rule: "circular-dependency",
      message: `Circular dependency detected: ${cycle.join(" → ")}`,
    });
  }

  return buildReport(issues);
}

// ── Export boundaries ───────────────────────────────────

const DEFAULT_SERVER_ONLY_PATTERNS = [
  "node:fs",
  "node:crypto",
  "node:child_process",
  "drizzle-orm",
  "postgres",
  "pg",
];

/**
 * Validate browser/server export boundaries.
 *
 * Ensures browser-safe entry points do not re-export server-only modules.
 */
export function validateExportPatterns(
  entryPoints: ExportBoundaryConfig[],
  files: FileContent[],
): QualityReport {
  const issues: QualityIssue[] = [];
  const fileMap = new Map(files.map((f) => [normalizePath(f.path), f]));

  for (const ep of entryPoints) {
    if (!ep.browserSafe) continue;

    const file = fileMap.get(normalizePath(ep.entryPoint));
    if (!file) continue;

    const serverPatterns = ep.serverOnlyPatterns ?? DEFAULT_SERVER_ONLY_PATTERNS;
    const imports = extractImports(file.content);

    for (const imp of imports) {
      for (const pattern of serverPatterns) {
        if (imp.source.includes(pattern)) {
          issues.push({
            severity: "error",
            rule: "export-boundary",
            message: `Browser-safe entry point "${ep.entryPoint}" imports server-only module "${imp.source}"`,
            file: ep.entryPoint,
            line: imp.line,
          });
        }
      }
    }
  }

  return buildReport(issues);
}

// ── Helpers ─────────────────────────────────────────────

interface ImportInfo {
  source: string;
  line: number;
}

function extractImports(content: string): ImportInfo[] {
  const results: ImportInfo[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i]?.match(/(?:import|export)\s+.*?from\s+["']([^"']+)["']/);
    if (match) {
      results.push({ source: match[1] as string, line: i + 1 });
    }
  }
  return results;
}

function categorizeImport(source: string): "external" | "internal" | "relative" {
  if (source.startsWith(".")) return "relative";
  if (source.startsWith("@linchkit/") || source.startsWith("~/")) return "internal";
  return "external";
}

function isOutOfOrder(
  prev: "external" | "internal" | "relative",
  curr: "external" | "internal" | "relative",
): boolean {
  const order = { external: 0, internal: 1, relative: 2 };
  return order[curr] < order[prev];
}

function resolveRelativeImport(filePath: string, importSource: string): string | null {
  const dir = filePath.substring(0, filePath.lastIndexOf("/"));
  if (!dir) return null;

  const parts = [...dir.split("/")];
  for (const segment of importSource.split("/")) {
    if (segment === "..") {
      parts.pop();
    } else if (segment !== ".") {
      parts.push(segment);
    }
  }
  return parts.join("/");
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\.tsx?$/, "");
}

function detectCycles(graph: Map<string, Set<string>>): string[][] {
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(node: string, path: string[]): void {
    if (inStack.has(node)) {
      const cycleStart = path.indexOf(node);
      if (cycleStart >= 0) {
        cycles.push([...path.slice(cycleStart), node]);
      }
      return;
    }
    if (visited.has(node)) return;

    visited.add(node);
    inStack.add(node);
    path.push(node);

    const deps = graph.get(node);
    if (deps) {
      for (const dep of deps) {
        dfs(dep, path);
      }
    }

    path.pop();
    inStack.delete(node);
  }

  for (const node of graph.keys()) {
    dfs(node, []);
  }

  return cycles;
}

function extractFileName(filePath: string): string | null {
  const parts = filePath.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || null;
}

function isTestFile(fileName: string): boolean {
  return /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(fileName);
}

function isDeclarationFile(fileName: string): boolean {
  return fileName.endsWith(".d.ts");
}

function lineNumber(content: string, charIndex: number): number {
  return content.substring(0, charIndex).split("\n").length;
}

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
