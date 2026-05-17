/**
 * Release Compatibility Checker — Spec 38 §9
 *
 * Analyzes Drizzle SQL migration files to classify each migration's
 * compatibility impact and produce a typed ReleaseCompatibilityResult.
 *
 * Classification rules follow Spec 38 §3.2:
 *   safe     — no DDL or DDL that old code can safely ignore
 *   expand   — adds structure; old code continues to work
 *   contract — removes / tightens structure; old code may break
 *   breaking — simultaneous incompatible changes; cannot blue-green deploy
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// ── Types ────────────────────────────────────────────────────────────────────

export type ReleaseType = "safe" | "expand" | "contract" | "breaking";
export type RollbackMode = "traffic_only" | "version_only" | "manual";

export interface TenantOverrideImpact {
  tenantId: string;
  target: string;
  status: "valid" | "needs_migration" | "invalid";
}

/** Typed result of a release compatibility analysis (Spec 38 §9). */
export interface ReleaseCompatibilityResult {
  releaseType: ReleaseType;
  oldVersionCanRead: boolean;
  oldVersionCanWrite: boolean;
  rollbackMode: RollbackMode;
  requiresBackfill: boolean;
  requiresDualWrite: boolean;
  /** Runtime tenant override impacts — empty from static analysis alone. */
  tenantOverrideImpact: TenantOverrideImpact[];
  /** Conditions that block the release per Spec 38 §9. */
  blockers: string[];
}

/** Per-statement classification detail. */
export interface StatementAnalysis {
  statement: string;
  type: ReleaseType;
  reason: string;
}

/** Full analysis including per-statement breakdown. */
export interface MigrationAnalysis {
  file: string;
  statements: StatementAnalysis[];
  result: ReleaseCompatibilityResult;
}

// ── SQL Statement Classifier ─────────────────────────────────────────────────

const RX = {
  createTable: /^\s*CREATE\s+TABLE\b/i,
  createType: /^\s*CREATE\s+TYPE\b/i,
  createIndex: /^\s*CREATE\s+(UNIQUE\s+)?INDEX\b/i,
  dropTable: /^\s*DROP\s+TABLE\b/i,
  dropType: /^\s*DROP\s+TYPE\b/i,
  dropIndex: /^\s*DROP\s+INDEX\b/i,
  addColumn: /^\s*ALTER\s+TABLE\b.+\bADD\s+COLUMN\b/i,
  dropColumn: /^\s*ALTER\s+TABLE\b.+\bDROP\s+COLUMN\b/i,
  renameColumn: /^\s*ALTER\s+TABLE\b.+\bRENAME\s+COLUMN\b/i,
  alterColumnType: /^\s*ALTER\s+TABLE\b.+\bALTER\s+COLUMN\b.+\bTYPE\b/i,
  alterColumnNotNull: /^\s*ALTER\s+TABLE\b.+\bALTER\s+COLUMN\b.+\bSET\s+NOT\s+NULL\b/i,
  alterColumnDropNotNull: /^\s*ALTER\s+TABLE\b.+\bALTER\s+COLUMN\b.+\bDROP\s+NOT\s+NULL\b/i,
  renameTable: /^\s*ALTER\s+TABLE\b.+\bRENAME\s+TO\b/i,
  notNull: /\bNOT\s+NULL\b/i,
  hasDefault: /\bDEFAULT\b/i,
};

/**
 * Classify a single SQL statement and return its type + reason.
 * Only the first matched rule wins; order matters (most specific first).
 */
export function classifyStatement(sql: string): StatementAnalysis {
  const stmt = sql.trim();

  if (RX.addColumn.test(stmt)) {
    // ADD COLUMN NOT NULL without DEFAULT → breaking (existing rows become invalid)
    if (RX.notNull.test(stmt) && !RX.hasDefault.test(stmt)) {
      return {
        statement: stmt,
        type: "breaking",
        reason: "ADD COLUMN NOT NULL without DEFAULT makes existing rows violate the constraint",
      };
    }
    return {
      statement: stmt,
      type: "expand",
      reason: "ADD COLUMN (nullable or with default) is backward compatible",
    };
  }

  if (RX.dropColumn.test(stmt)) {
    return {
      statement: stmt,
      type: "contract",
      reason: "DROP COLUMN removes structure that old code may still reference",
    };
  }

  if (RX.renameColumn.test(stmt)) {
    return {
      statement: stmt,
      type: "contract",
      reason: "RENAME COLUMN breaks old code that reads or writes by the old name",
    };
  }

  if (RX.alterColumnType.test(stmt)) {
    return {
      statement: stmt,
      type: "breaking",
      reason: "ALTER COLUMN TYPE may make existing data unreadable by old code",
    };
  }

  if (RX.alterColumnNotNull.test(stmt)) {
    return {
      statement: stmt,
      type: "contract",
      reason: "SET NOT NULL tightens constraints; existing NULL rows cause migration failures",
    };
  }

  if (RX.alterColumnDropNotNull.test(stmt)) {
    return {
      statement: stmt,
      type: "expand",
      reason: "DROP NOT NULL relaxes a constraint; old code continues to work",
    };
  }

  if (RX.renameTable.test(stmt)) {
    return {
      statement: stmt,
      type: "contract",
      reason: "RENAME TABLE breaks old code that references the old table name",
    };
  }

  if (RX.dropTable.test(stmt)) {
    return {
      statement: stmt,
      type: "contract",
      reason: "DROP TABLE removes structure that old code may still use",
    };
  }

  if (RX.dropType.test(stmt)) {
    return {
      statement: stmt,
      type: "contract",
      reason: "DROP TYPE removes a type that old code may still reference",
    };
  }

  if (RX.dropIndex.test(stmt)) {
    return {
      statement: stmt,
      type: "safe",
      reason: "DROP INDEX does not affect read/write correctness",
    };
  }

  if (RX.createTable.test(stmt)) {
    return {
      statement: stmt,
      type: "expand",
      reason: "CREATE TABLE adds new structure; old code ignores it safely",
    };
  }

  if (RX.createType.test(stmt)) {
    return {
      statement: stmt,
      type: "expand",
      reason: "CREATE TYPE adds a new type; old code ignores it safely",
    };
  }

  if (RX.createIndex.test(stmt)) {
    return {
      statement: stmt,
      type: "expand",
      reason: "CREATE INDEX improves performance; old code is unaffected",
    };
  }

  // Unknown or comment-only statements — treat as safe
  return {
    statement: stmt,
    type: "safe",
    reason: "Statement does not match any known DDL pattern",
  };
}

// ── Release Type Aggregation ─────────────────────────────────────────────────

const TYPE_RANK: Record<ReleaseType, number> = {
  safe: 0,
  expand: 1,
  contract: 2,
  breaking: 3,
};

/** Reduce a list of per-statement types to the overall release type. */
export function aggregateReleaseType(types: ReleaseType[]): ReleaseType {
  if (types.length === 0) return "safe";
  return types.reduce<ReleaseType>(
    (worst, t) => (TYPE_RANK[t] > TYPE_RANK[worst] ? t : worst),
    "safe",
  );
}

// ── Result Builder ───────────────────────────────────────────────────────────

/** Derive the full ReleaseCompatibilityResult from a release type. */
export function buildResult(
  releaseType: ReleaseType,
  tenantOverrideImpact: TenantOverrideImpact[] = [],
): ReleaseCompatibilityResult {
  const base: Omit<ReleaseCompatibilityResult, "blockers"> = (() => {
    switch (releaseType) {
      case "safe":
        return {
          releaseType,
          oldVersionCanRead: true,
          oldVersionCanWrite: true,
          rollbackMode: "traffic_only",
          requiresBackfill: false,
          requiresDualWrite: false,
          tenantOverrideImpact,
        };
      case "expand":
        return {
          releaseType,
          oldVersionCanRead: true,
          oldVersionCanWrite: true,
          rollbackMode: "traffic_only",
          requiresBackfill: false,
          requiresDualWrite: false,
          tenantOverrideImpact,
        };
      case "contract":
        return {
          releaseType,
          oldVersionCanRead: false,
          oldVersionCanWrite: true,
          rollbackMode: "version_only",
          requiresBackfill: true,
          requiresDualWrite: true,
          tenantOverrideImpact,
        };
      case "breaking":
        return {
          releaseType,
          oldVersionCanRead: false,
          oldVersionCanWrite: false,
          rollbackMode: "manual",
          requiresBackfill: true,
          requiresDualWrite: false,
          tenantOverrideImpact,
        };
    }
  })();

  const blockers: string[] = [];

  if (releaseType === "breaking") {
    blockers.push(
      "Release type is 'breaking': cannot be deployed in blue-green mode without a redesigned migration plan",
    );
  }
  if (!base.oldVersionCanRead) {
    blockers.push("Old version cannot safely read from the database after this migration");
  }
  if (!base.oldVersionCanWrite) {
    blockers.push("Old version cannot safely write to the database after this migration");
  }

  const invalidOverrides = tenantOverrideImpact.filter((o) => o.status === "invalid");
  for (const o of invalidOverrides) {
    blockers.push(`Tenant override invalid: tenant=${o.tenantId} target=${o.target}`);
  }

  return { ...base, blockers };
}

// ── SQL Splitter ─────────────────────────────────────────────────────────────

/**
 * Split a Drizzle migration file into individual SQL statements.
 * Drizzle uses `--> statement-breakpoint` as statement delimiter.
 * Falls back to splitting on `;` for non-Drizzle SQL.
 */
export function splitStatements(sql: string): string[] {
  const hasDrizzleBreakpoints = sql.includes("--> statement-breakpoint");
  const raw = hasDrizzleBreakpoints ? sql.split("--> statement-breakpoint") : sql.split(";");

  return raw
    .map((segment) => {
      // Strip leading comment lines from each segment, then trim
      const withoutLeadingComments = segment
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim();
      return withoutLeadingComments;
    })
    .filter((s) => s.length > 0);
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Analyze a single SQL migration string. */
export function analyzeMigrationSql(sql: string, fileName = "<inline>"): MigrationAnalysis {
  const stmts = splitStatements(sql);
  const statements = stmts.map(classifyStatement);
  const releaseType = aggregateReleaseType(statements.map((s) => s.type));
  return {
    file: fileName,
    statements,
    result: buildResult(releaseType),
  };
}

/** Analyze all *.sql files in a Drizzle migrations directory. */
export async function checkReleaseCompatibility(
  migrationsDir: string,
): Promise<ReleaseCompatibilityResult> {
  let files: string[];
  try {
    const entries = await readdir(migrationsDir);
    files = entries.filter((f) => f.endsWith(".sql")).sort();
  } catch {
    // No migrations directory or empty — treat as safe
    return buildResult("safe");
  }

  if (files.length === 0) return buildResult("safe");

  const allStatementTypes: ReleaseType[] = [];

  for (const file of files) {
    const sql = await readFile(join(migrationsDir, file), "utf-8");
    const stmts = splitStatements(sql).map(classifyStatement);
    allStatementTypes.push(...stmts.map((s) => s.type));
  }

  const releaseType = aggregateReleaseType(allStatementTypes);
  return buildResult(releaseType);
}

/** Analyze a specific migration file by path. */
export async function analyzeFile(filePath: string): Promise<MigrationAnalysis> {
  const sql = await readFile(filePath, "utf-8");
  const name = filePath.split("/").pop() ?? filePath;
  return analyzeMigrationSql(sql, name);
}
