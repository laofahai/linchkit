/**
 * Applied-migrations reader
 *
 * Builds the `appliedMigrationsReader` that the core `MigrationCoordinator`
 * (Spec 12 §5) requires: a `() => Promise<ReadonlySet<string>>` returning the
 * migration TAGS actually applied to the target database.
 *
 * The coordinator is intentionally DB-agnostic and has NO default reader (it
 * throws when omitted), because the on-disk drizzle journal lists *generated*
 * migrations, not *applied* ones. The genuinely-applied set lives in the DB, so
 * this DB-querying reader belongs in cap-migration (which holds the db handle).
 *
 * How applied state is stored
 * ---------------------------
 * `runMigrations(db)` (db-migrate.ts) calls drizzle-orm's
 * `migrate(db, { migrationsFolder })` with NO `migrationsTable`/`migrationsSchema`
 * override, so drizzle-orm uses its defaults:
 *
 *   schema = "drizzle", table = "__drizzle_migrations"
 *     columns: id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint
 *
 * (verified against drizzle-orm 0.45.1 `pg-core/dialect` `migrate()`.)
 *
 * Each applied row's `created_at` is set to the migration's `folderMillis`, which
 * drizzle-orm's `readMigrationFiles` reads verbatim from the journal entry's
 * `when` field. So a row's `created_at` (epoch ms) maps 1:1 back to the journal
 * entry whose `when` equals it, and that entry's `tag` is the migration id the
 * coordinator partitions on.
 *
 * Mapping approach
 * ----------------
 *   1. SELECT created_at FROM drizzle.__drizzle_migrations  (parameterless,
 *      identifiers via drizzle `sql.identifier` — no string-built SQL).
 *      Fresh DB / table never created → return an EMPTY set (never throw).
 *   2. Read `<migrationsDir>/meta/_journal.json`; build `when(ms) → tag`.
 *   3. For each row, look up its `created_at` in the map; collect the tag.
 *      Rows with no matching journal entry are skipped (best-effort). A
 *      missing/malformed journal yields an empty set (never throws).
 */

import { join, resolve } from "node:path";
import {
  createMigrationCoordinator,
  type MigrationCoordinator,
  type MigrationCoordinatorOptions,
} from "@linchkit/core/server";
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { runMigrations, runReverseMigration } from "./db-migrate";

/** Schema drizzle-orm's pg migrator uses by default (no override in runMigrations). */
const MIGRATIONS_SCHEMA = "drizzle";
/** Table drizzle-orm's pg migrator uses by default. */
const MIGRATIONS_TABLE = "__drizzle_migrations";

/** Default migrations folder — mirrors `runMigrations` / drizzle.config. */
const DEFAULT_MIGRATIONS_DIR = "./drizzle/migrations";

/**
 * PostgreSQL `SQLSTATE` codes meaning "the applied-state table can't exist yet",
 * which we treat as "nothing applied" rather than an error:
 *   42P01 — undefined_table (the table does not exist)
 *   3F000 — invalid_schema_name (the `drizzle` schema does not exist)
 */
const MISSING_TABLE_SQLSTATES = new Set(["42P01", "3F000"]);

/**
 * The minimal database surface this reader needs: a Drizzle `execute` that runs a
 * parameterized `sql` query and resolves to the result rows. `PostgresJsDatabase`
 * satisfies this structurally, and tests can supply a tiny fake. Kept narrow so
 * the reader never reaches for anything but a read query.
 */
export interface MigrationStateDb {
  execute: PostgresJsDatabase["execute"];
}

export interface AppliedMigrationsReaderOptions {
  /** Drizzle database handle (or any `{ execute }` matching `MigrationStateDb`). */
  db: MigrationStateDb;
  /**
   * Migrations folder containing `meta/_journal.json`.
   * Default: "./drizzle/migrations" (matches `runMigrations`).
   */
  migrationsDir?: string;
}

/** Shape of a journal entry we rely on (`meta/_journal.json` → `entries[]`). */
interface JournalEntry {
  when: number;
  tag: string;
}

/**
 * Narrow an unknown PG driver error to its `SQLSTATE`/`code`, if present.
 * postgres.js surfaces it as `err.code`; node-postgres also uses `code`.
 */
function pgErrorCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/**
 * Normalize a `created_at` cell to epoch milliseconds. The column is `bigint`, so
 * postgres.js returns it as a string by default; be tolerant of number/bigint too.
 * Returns `undefined` for values that can't be a finite integer epoch.
 */
function toEpochMs(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0 || !/^-?\d+$/.test(trimmed)) return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Read `<migrationsDir>/meta/_journal.json` and build a `when(epoch ms) → tag`
 * map. Returns an empty map if the journal is missing or malformed (never throws)
 * so a journal problem degrades to "nothing matched" rather than a crash.
 */
async function readJournalWhenToTag(migrationsDir: string): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  const journalPath = join(migrationsDir, "meta", "_journal.json");
  try {
    const file = Bun.file(journalPath);
    if (!(await file.exists())) return map;
    const parsed: unknown = await file.json();
    if (typeof parsed !== "object" || parsed === null || !("entries" in parsed)) {
      return map;
    }
    const entries = (parsed as { entries: unknown }).entries;
    if (!Array.isArray(entries)) return map;
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) continue;
      const when = (entry as Partial<JournalEntry>).when;
      const tag = (entry as Partial<JournalEntry>).tag;
      if (typeof when === "number" && Number.isFinite(when) && typeof tag === "string") {
        map.set(when, tag);
      }
    }
  } catch {
    // Malformed JSON / read error → best-effort empty map (never throw).
    return new Map<number, string>();
  }
  return map;
}

/**
 * Query the applied rows' `created_at` values from drizzle's migrations table.
 * Returns an empty array when the table/schema does not exist yet (fresh DB).
 * Re-throws any other DB error so genuine failures are not silently swallowed.
 */
async function readAppliedCreatedAt(db: MigrationStateDb): Promise<unknown[]> {
  try {
    // Identifiers via `sql.identifier` (not string concatenation); no user input.
    const rows = await db.execute(
      sql`select created_at from ${sql.identifier(MIGRATIONS_SCHEMA)}.${sql.identifier(
        MIGRATIONS_TABLE,
      )}`,
    );
    return Array.isArray(rows) ? rows : [...(rows as Iterable<unknown>)];
  } catch (err) {
    if (MISSING_TABLE_SQLSTATES.has(pgErrorCode(err) ?? "")) {
      return [];
    }
    throw err;
  }
}

/**
 * Extract `created_at` from a result row, tolerating either object rows
 * (`{ created_at }`) or positional tuples (`[created_at]`).
 */
function rowCreatedAt(row: unknown): unknown {
  if (Array.isArray(row)) return row[0];
  if (typeof row === "object" && row !== null && "created_at" in row) {
    return (row as { created_at: unknown }).created_at;
  }
  return undefined;
}

/**
 * Build the coordinator's `appliedMigrationsReader`.
 *
 * Returns `() => Promise<ReadonlySet<string>>` resolving to the set of migration
 * tags applied to `db`. Inject the result into
 * `MigrationCoordinatorOptions.appliedMigrationsReader`.
 *
 * @example
 *   import { createMigrationCoordinator } from "@linchkit/core/server";
 *   import { createAppliedMigrationsReader, runMigrations } from "@linchkit/cap-migration";
 *
 *   const coordinator = createMigrationCoordinator({
 *     repoDir: process.cwd(),
 *     appliedMigrationsReader: createAppliedMigrationsReader({ db }),
 *     forwardApply: () => runMigrations(db),
 *     // sqlExecutor: (sqlPath) => runReverseMigration(db, { sqlPath }),
 *   });
 */
export function createAppliedMigrationsReader(
  options: AppliedMigrationsReaderOptions,
): () => Promise<ReadonlySet<string>> {
  const { db } = options;
  const migrationsDir = options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;

  return async (): Promise<ReadonlySet<string>> => {
    const rows = await readAppliedCreatedAt(db);
    if (rows.length === 0) return new Set<string>();

    const whenToTag = await readJournalWhenToTag(migrationsDir);
    if (whenToTag.size === 0) return new Set<string>();

    const applied = new Set<string>();
    for (const row of rows) {
      const ms = toEpochMs(rowCreatedAt(row));
      if (ms === undefined) continue;
      const tag = whenToTag.get(ms);
      // Skip rows whose created_at has no matching journal entry (best-effort).
      if (tag !== undefined) applied.add(tag);
    }
    return applied;
  };
}

export interface DbMigrationCoordinatorOptions
  extends Omit<
    MigrationCoordinatorOptions,
    "appliedMigrationsReader" | "forwardApply" | "sqlExecutor"
  > {
  /** Drizzle database handle the reader/runners operate against. */
  db: PostgresJsDatabase;
}

/**
 * Construct a `MigrationCoordinator` fully wired to a Drizzle database:
 *   - `appliedMigrationsReader` ← `createAppliedMigrationsReader({ db, ... })`
 *   - `forwardApply`            ← `runMigrations(db)`
 *   - `sqlExecutor`             ← `runReverseMigration(db, { sqlPath })`
 *
 * This is the ready-to-use entry point so callers don't have to hand-wire the
 * three DB-aware injections themselves. The reader's journal dir is resolved as
 * `<repoDir>/<migrationsDir>` to match how the coordinator joins those paths;
 * `runMigrations` is given the same absolute folder so DB and on-disk stay in
 * sync. Any other coordinator option (dryRun, allowIrreversible, classifyRelease,
 * dirReader, logger, clock) passes through unchanged.
 *
 * @example
 *   import { createDatabase } from "@linchkit/core/server";
 *   import { createDbMigrationCoordinator } from "@linchkit/cap-migration";
 *
 *   const db = createDatabase({ url: process.env.DATABASE_URL! });
 *   const coordinator = createDbMigrationCoordinator({ db, repoDir: process.cwd() });
 *   const preflight = await coordinator.preFlight();
 */
export function createDbMigrationCoordinator(
  options: DbMigrationCoordinatorOptions,
): MigrationCoordinator {
  const { db, ...coordinatorOptions } = options;
  const migrationsDir = coordinatorOptions.migrationsDir ?? "drizzle/migrations";
  // Resolve robustly via node:path: an absolute migrationsDir is honored as-is,
  // a relative one is joined onto repoDir (resolve handles trailing slashes and
  // the absolute-path case), keeping the reader's journal dir and the
  // forward-apply folder in lock-step with how the coordinator joins paths.
  const absoluteMigrationsDir = resolve(coordinatorOptions.repoDir, migrationsDir);

  return createMigrationCoordinator({
    ...coordinatorOptions,
    appliedMigrationsReader: createAppliedMigrationsReader({
      db,
      migrationsDir: absoluteMigrationsDir,
    }),
    forwardApply: () => runMigrations(db, { migrationsFolder: absoluteMigrationsDir }),
    sqlExecutor: (sqlPath) => runReverseMigration(db, { sqlPath }),
  });
}
