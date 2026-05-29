/**
 * MigrationCoordinator — Spec 12 §5 "DB Migration".
 *
 * Coordinates forward and reverse DB migrations around a blue-green release:
 *
 *   pre-flight → forward (apply pending) → (on failure) reverse applied
 *
 * Drizzle has NO native `down` step and CLAUDE.md forbids hand-writing DDL.
 * Reverse migrations are therefore realized via committed `down.sql` artifacts:
 * each drizzle-kit generated forward migration `NNNN_name.sql` (under the
 * migrations dir) MAY have a sibling `NNNN_name.down.sql`. The coordinator
 * EXECUTES those committed artifacts — it never generates DDL (Spec 12 §5.1).
 *
 * Safety policy (Spec 12 §5.2):
 *   - safe / expand releases  → ok
 *   - contract releases       → warning
 *   - breaking releases, or any pending migration that lacks a `down.sql`,
 *     are irreversible → blocker + `ok=false` UNLESS `allowIrreversible` is
 *     set (the "manual confirmation" gate).
 *
 * Applied-vs-pending detection is DB-driven, NOT journal-driven. Drizzle's
 * `<migrationsDir>/meta/_journal.json` is the on-disk registry of every
 * GENERATED migration (written by `drizzle-kit generate`); it says nothing about
 * what has actually been applied to a given database. The genuinely-applied set
 * lives in the DB (drizzle's `__drizzle_migrations` table). The coordinator
 * therefore consumes an injected `appliedMigrationsReader` that returns the tags
 * applied to the target DB, and computes `pending = on-disk MINUS applied`. The
 * coordinator stays DB-agnostic: the concrete DB-querying reader belongs in
 * cap-migration (which holds the db handle), so the reader is REQUIRED — there
 * is deliberately no journal-based fallback.
 *
 * All I/O (the forward apply, reverse SQL execution, filesystem listing, and the
 * applied-set read) is injectable so the core logic is unit-testable without a
 * real database or disk. The default forward apply wraps cap-migration's
 * `runMigrations(db)`; the default reverse SQL executor wraps cap-migration's
 * `runReverseMigration(db, { sqlPath })`. The coordinator itself stays
 * DB-agnostic via the injected runners.
 *
 * This engine is intentionally DECOUPLED from BlueGreenDeployer and
 * DeployRollbackOrchestrator — wiring it into the deploy path is a later concern.
 * It never throws on operational failure: it returns `{ success: false, phase }`.
 */

import type { Logger } from "../types/logger";

// ── Types ────────────────────────────────────────────────────────────────

/**
 * Apply all pending forward migrations. Default wraps cap-migration's
 * `runMigrations(db)`; injectable for tests. Rejects on failure.
 */
export type ForwardApplyRunner = () => Promise<void>;

/**
 * Execute a single reverse migration's `down.sql` (given its absolute path).
 * Default wraps cap-migration's `runReverseMigration(db, { sqlPath })`;
 * injectable for tests. Rejects on failure.
 */
export type SqlExecutor = (sqlPath: string) => Promise<void>;

/**
 * Discover the migrations dir contents. Returns the file names (not paths) found
 * directly under the migrations dir. Injectable so tests feed canned data without
 * touching disk. Default reads the drizzle migrations dir listing.
 */
export type MigrationDirReader = () => Promise<readonly string[]>;

/**
 * Read the set of migration tags ACTUALLY APPLIED to the target database.
 *
 * This is the source of truth for the applied-vs-pending partition. It MUST
 * reflect the database state, NOT the on-disk migration registry: drizzle's
 * `<migrationsDir>/meta/_journal.json` lists every GENERATED migration (written
 * by `drizzle-kit generate`) and would make the pending set always empty. The
 * genuinely-applied set lives in drizzle's `__drizzle_migrations` table
 * (`id, hash, created_at`, where `created_at` equals the journal entry's `when`),
 * so a correct reader queries that table and maps each row back to its tag.
 *
 * Returns the set of applied migration tags (e.g. "0001_greedy_king_bedlam").
 * The coordinator intersects this set with the on-disk listing for reverse and
 * subtracts it from the on-disk listing for forward.
 *
 * Required: a concrete DB-querying reader belongs in cap-migration (which holds
 * the db handle). The core coordinator stays DB-agnostic and has no default —
 * omitting it throws a clear error rather than silently falling back to the
 * journal (which would be incorrect).
 */
export type AppliedMigrationsReader = () => Promise<ReadonlySet<string>>;

export type MigrationPhase =
  | "idle"
  | "pre-flight"
  | "forward"
  | "reverse"
  | "done"
  | "failed"
  | "aborted";

export type MigrationDirection = "forward" | "reverse";

/** Release classification used by the §5.2 safety policy. */
export type MigrationReleaseType = "safe" | "expand" | "contract" | "breaking";

export interface PendingMigration {
  /** Migration id / drizzle tag, e.g. "0007_add_inbound_status". */
  id: string;
  /** Absolute path to the forward `NNNN_name.sql`. */
  forwardSqlPath: string;
  /** Absolute path to the sibling `NNNN_name.down.sql`, when it exists. */
  reverseSqlPath?: string;
  /** Whether a sibling `down.sql` was found for this migration. */
  hasReverse: boolean;
}

export interface PreFlightResult {
  /** Whether it is safe to proceed without manual confirmation. */
  ok: boolean;
  /** Pending (not-yet-applied) migrations discovered, in id order. */
  pending: PendingMigration[];
  /** True when every pending migration has a committed `down.sql`. */
  reversibleAll: boolean;
  /** Release classification driving the safety policy. */
  releaseType: MigrationReleaseType;
  /** Reasons the release is blocked (empty when `ok`). */
  blockers: string[];
  /** Non-blocking advisories (e.g. contract releases). */
  warnings: string[];
}

export interface MigrationResult {
  success: boolean;
  phase: MigrationPhase;
  direction: MigrationDirection;
  /** Migration ids successfully applied (forward) or reverted (reverse). */
  applied: string[];
  durationMs: number;
  error?: string;
}

export interface MigrationCoordinatorOptions {
  /** Absolute path to the repository root. */
  repoDir: string;
  /** Migrations dir relative to repoDir. Default: "drizzle/migrations". */
  migrationsDir?: string;
  /** When true, pre-flight only — never call forwardApply. Default: false. */
  dryRun?: boolean;
  /**
   * Manual-confirmation gate (Spec 12 §5.2). When true, an irreversible release
   * (breaking, or a pending migration without a `down.sql`) is allowed instead
   * of being a blocker. Default: false.
   */
  allowIrreversible?: boolean;
  /** Injectable forward apply. Default: cap-migration runMigrations(db). */
  forwardApply?: ForwardApplyRunner;
  /** Injectable reverse SQL executor. Default: cap-migration runReverseMigration. */
  sqlExecutor?: SqlExecutor;
  /** Injectable migrations-dir reader. Default: drizzle migrations dir listing. */
  dirReader?: MigrationDirReader;
  /**
   * REQUIRED reader of the migration tags ACTUALLY APPLIED to the target DB.
   * There is no default (a journal-based fallback would be incorrect — the
   * journal lists generated, not applied, migrations). A correct reader queries
   * drizzle's `__drizzle_migrations` table; that DB-aware implementation belongs
   * in cap-migration. Omitting it makes every applied/pending discovery throw.
   */
  appliedMigrationsReader?: AppliedMigrationsReader;
  /** Injectable classifier of the release type. Default: () => "safe". */
  classifyRelease?: () => MigrationReleaseType | Promise<MigrationReleaseType>;
  /** Optional logger. */
  logger?: Logger;
  /** Injectable clock for tests — returns epoch millis. */
  clock?: () => number;
}

// ── Constants ────────────────────────────────────────────────────────────

const DEFAULT_MIGRATIONS_DIR = "drizzle/migrations";
const FORWARD_SQL_RE = /^(\d{4,})_[A-Za-z0-9_-]+\.sql$/;
const REVERSE_SUFFIX = ".down.sql";

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Reject migration ids / relative paths that could escape the migrations dir or
 * inject a flag into the drizzle-kit / shell-free runners. Mirrors the SHA
 * validation in DeployRollbackOrchestrator. Returns the trimmed id on success.
 */
function assertSafeId(id: string): string {
  const trimmed = id.trim();
  if (trimmed.length === 0) {
    throw new Error("MigrationCoordinator: migration id must be non-empty");
  }
  if (trimmed.startsWith("-")) {
    throw new Error(`MigrationCoordinator: migration id must not start with '-': "${id}"`);
  }
  // Only the drizzle tag charset: digits/letters/underscore/hyphen — no path
  // separators, no "..", no whitespace.
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    throw new Error(`MigrationCoordinator: invalid migration id "${id}"`);
  }
  return trimmed;
}

/**
 * Join `migrationsDir` + `file` and assert the result stays under the
 * migrations dir (no traversal, no absolute escape). Returns the absolute path.
 */
function safeJoin(repoDir: string, migrationsDir: string, file: string): string {
  if (file.includes("/") || file.includes("\\") || file.includes("..")) {
    throw new Error(`MigrationCoordinator: unsafe migration file name "${file}"`);
  }
  return `${repoDir}/${migrationsDir}/${file}`;
}

// ── MigrationCoordinator ───────────────────────────────────────────────────

export class MigrationCoordinator {
  private readonly repoDir: string;
  private readonly migrationsDir: string;
  private readonly dryRun: boolean;
  private readonly allowIrreversible: boolean;
  private readonly forwardApply: ForwardApplyRunner;
  private readonly sqlExecutor: SqlExecutor;
  private readonly dirReader: MigrationDirReader;
  private readonly appliedMigrationsReader: AppliedMigrationsReader;
  private readonly classifyRelease: () => MigrationReleaseType | Promise<MigrationReleaseType>;
  private readonly logger?: Logger;
  private readonly clock: () => number;

  constructor(options: MigrationCoordinatorOptions) {
    this.repoDir = options.repoDir;
    this.migrationsDir = options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
    this.dryRun = options.dryRun ?? false;
    this.allowIrreversible = options.allowIrreversible ?? false;
    this.forwardApply =
      options.forwardApply ??
      (() => {
        throw new Error(
          "MigrationCoordinator: no forwardApply provided. Inject one that wraps cap-migration runMigrations(db).",
        );
      });
    this.sqlExecutor =
      options.sqlExecutor ??
      (() => {
        throw new Error(
          "MigrationCoordinator: no sqlExecutor provided. Inject one that wraps cap-migration runReverseMigration(db).",
        );
      });
    this.dirReader = options.dirReader ?? this.defaultDirReader.bind(this);
    this.appliedMigrationsReader =
      options.appliedMigrationsReader ??
      (() => {
        throw new Error(
          "MigrationCoordinator: appliedMigrationsReader is required to determine applied migrations. Inject one that queries the DB (drizzle's __drizzle_migrations table) — the on-disk journal does NOT reflect what is applied.",
        );
      });
    this.classifyRelease = options.classifyRelease ?? (() => "safe");
    this.logger = options.logger;
    this.clock = options.clock ?? Date.now;
  }

  /**
   * Discover pending migrations, detect sibling `down.sql` artifacts, classify
   * the release, and apply the §5.2 safety policy.
   *
   * - safe / expand → ok
   * - contract → warning (still ok)
   * - breaking, or any pending migration without a `down.sql` → blocker + ok=false
   *   UNLESS `allowIrreversible` is set (the manual-confirmation gate).
   */
  async preFlight(): Promise<PreFlightResult> {
    this.logger?.info?.("MigrationCoordinator: pre-flight starting", {
      migrationsDir: this.migrationsDir,
      dryRun: this.dryRun,
    });

    const pending = await this.discoverPending();
    const releaseType = await this.classifyRelease();
    const reversibleAll = pending.every((m) => m.hasReverse);

    const blockers: string[] = [];
    const warnings: string[] = [];

    const irreversibleIds = pending.filter((m) => !m.hasReverse).map((m) => m.id);
    if (irreversibleIds.length > 0) {
      blockers.push(
        `Irreversible: ${irreversibleIds.length} pending migration(s) lack a down.sql (${irreversibleIds.join(", ")})`,
      );
    }
    if (releaseType === "breaking") {
      blockers.push("Breaking release — requires manual confirmation (Spec 12 §5.2)");
    }
    if (releaseType === "contract") {
      warnings.push(
        "Contract release — old code may break after migration; deploy code first, migrate next version (Spec 12 §5.2)",
      );
    }

    // The manual-confirmation gate clears the irreversibility blockers (and only
    // those) — operational discovery errors are never produced here, so any
    // blocker present is policy-driven.
    let ok = blockers.length === 0;
    if (!ok && this.allowIrreversible) {
      for (const b of blockers) {
        warnings.push(`Manually confirmed (allowIrreversible): ${b}`);
      }
      ok = true;
    }

    this.logger?.info?.("MigrationCoordinator: pre-flight complete", {
      pending: pending.length,
      releaseType,
      reversibleAll,
      ok,
      blockers: blockers.length,
    });

    return { ok, pending, reversibleAll, releaseType, blockers, warnings };
  }

  /**
   * Apply all pending forward migrations via `forwardApply`.
   *
   * "Pending" is computed by subtracting the DB-applied set (from
   * `appliedMigrationsReader`) from the on-disk migrations, so it is ONLY the
   * not-yet-applied set. On `dryRun`, forwardApply is NEVER called — returns
   * `phase:"done"` with no applied ids. On success, returns `phase:"done"`.
   *
   * On failure, performs a best-effort reverse of EXACTLY the pending migrations
   * this run attempted (those that have a committed `down.sql`), newest → oldest,
   * never masking the original error, and returns `phase:"aborted", success:false`.
   *
   * CRITICAL safety guarantee: already-applied migrations (those the DB reports as
   * applied before this run) are NEVER in `pending`, so a forward failure can
   * never run their `down.sql` and wipe data the DB already holds. Never throws on
   * operational failure.
   */
  async migrateForward(): Promise<MigrationResult> {
    const startMs = this.clock();
    const elapsed = () => this.clock() - startMs;
    const direction: MigrationDirection = "forward";

    if (this.dryRun) {
      this.logger?.info?.("MigrationCoordinator: dryRun — skipping forwardApply");
      return { success: true, phase: "done", direction, applied: [], durationMs: elapsed() };
    }

    // Capture the migrations we are about to apply so a failure can attempt a
    // best-effort reverse of EXACTLY those (the DB-diffed pending set —
    // never already-applied migrations).
    let pending: PendingMigration[];
    try {
      pending = await this.discoverPending();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger?.error?.("MigrationCoordinator: could not discover pending migrations", {
        error: msg,
      });
      return {
        success: false,
        phase: "failed",
        direction,
        applied: [],
        durationMs: elapsed(),
        error: `Pre-flight discovery failed: ${msg}`,
      };
    }

    this.logger?.info?.("MigrationCoordinator: applying forward migrations", {
      pending: pending.map((m) => m.id),
    });

    try {
      await this.forwardApply();
      const applied = pending.map((m) => m.id);
      this.logger?.info?.("MigrationCoordinator: forward migrations applied", { applied });
      return { success: true, phase: "done", direction, applied, durationMs: elapsed() };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger?.error?.("MigrationCoordinator: forward apply failed — attempting reverse", {
        error: msg,
      });
      // Best-effort reverse of the migrations we attempted. Reverse in reverse id
      // order so dependent migrations unwind correctly. Never masks `msg`.
      await this.reverseBestEffort(pending);
      return {
        success: false,
        phase: "aborted",
        direction,
        applied: [],
        durationMs: elapsed(),
        error: `Forward apply failed: ${msg}`,
      };
    }
  }

  /**
   * Reverse DB-applied migrations by executing their committed `down.sql` in
   * newest → oldest id order via `sqlExecutor`.
   *
   * `targetId` semantics — EXCLUSIVE floor (the intuitive `migrate:down --to <id>`
   * contract): every applied migration STRICTLY NEWER than `targetId` is reverted;
   * `targetId` itself and everything older are KEPT. After the call the DB sits at
   * `targetId`. Omit `targetId` to revert all applied migrations (back to a fresh
   * DB). If `targetId` is supplied but is not among the applied migrations, the
   * call is rejected (`success:false`, nothing executed) rather than silently
   * rolling everything back.
   *
   * Only DB-applied migrations are ever considered — pending (not-yet-applied)
   * migrations are never reverted here.
   *
   * If any migration to be reverted lacks a `down.sql`, NO statements are
   * executed (no partial execution) — returns a blocker `success:false`.
   * Never throws on operational failure.
   */
  async migrateReverse(targetId?: string): Promise<MigrationResult> {
    const startMs = this.clock();
    const elapsed = () => this.clock() - startMs;
    const direction: MigrationDirection = "reverse";

    if (targetId !== undefined) {
      try {
        assertSafeId(targetId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          phase: "failed",
          direction,
          applied: [],
          durationMs: elapsed(),
          error: msg,
        };
      }
    }

    let applied: PendingMigration[];
    try {
      // "applied" = migrations the DB reports as applied AND present on disk;
      // reverse the newest first. discoverApplied returns id-ascending; we
      // reverse below.
      applied = await this.discoverApplied();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger?.error?.("MigrationCoordinator: could not discover applied migrations", {
        error: msg,
      });
      return {
        success: false,
        phase: "failed",
        direction,
        applied: [],
        durationMs: elapsed(),
        error: `Discovery failed: ${msg}`,
      };
    }

    // Guard: an unknown `targetId` would otherwise drop through the loop without
    // ever hitting the floor and revert EVERYTHING. Reject it explicitly.
    if (targetId !== undefined && !applied.some((m) => m.id === targetId)) {
      const error = `Cannot reverse: targetId "${targetId}" is not an applied migration — no statements executed`;
      this.logger?.error?.("MigrationCoordinator: reverse blocked — unknown targetId", {
        targetId,
      });
      return {
        success: false,
        phase: "failed",
        direction,
        applied: [],
        durationMs: elapsed(),
        error,
      };
    }

    // Newest → oldest. Stop at `targetId` (exclusive: target itself kept).
    const ordered = [...applied].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    const toRevert: PendingMigration[] = [];
    for (const m of ordered) {
      if (targetId !== undefined && m.id === targetId) break;
      toRevert.push(m);
    }

    if (toRevert.length === 0) {
      this.logger?.info?.("MigrationCoordinator: nothing to reverse");
      return { success: true, phase: "done", direction, applied: [], durationMs: elapsed() };
    }

    // Guard: every migration we intend to revert must have a down.sql.
    // Bail out BEFORE executing anything to avoid a partial reverse.
    const missing = toRevert.filter((m) => !m.hasReverse).map((m) => m.id);
    if (missing.length > 0) {
      const error = `Cannot reverse: missing down.sql for ${missing.join(", ")} — no statements executed`;
      this.logger?.error?.("MigrationCoordinator: reverse blocked — missing down.sql", { missing });
      return {
        success: false,
        phase: "failed",
        direction,
        applied: [],
        durationMs: elapsed(),
        error,
      };
    }

    const reverted: string[] = [];
    for (const m of toRevert) {
      // reverseSqlPath is guaranteed by the `missing` guard above.
      const sqlPath = m.reverseSqlPath as string;
      try {
        this.logger?.info?.("MigrationCoordinator: reverting migration", { id: m.id, sqlPath });
        await this.sqlExecutor(sqlPath);
        reverted.push(m.id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger?.error?.("MigrationCoordinator: reverse execution failed", {
          id: m.id,
          error: msg,
        });
        return {
          success: false,
          phase: "aborted",
          direction,
          applied: reverted,
          durationMs: elapsed(),
          error: `Reverse of "${m.id}" failed: ${msg}`,
        };
      }
    }

    this.logger?.info?.("MigrationCoordinator: reverse complete", { reverted });
    return { success: true, phase: "done", direction, applied: reverted, durationMs: elapsed() };
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /**
   * List every forward migration on disk (id-ascending), each annotated with
   * whether a sibling `down.sql` exists. This is the raw on-disk set — neither
   * the applied nor the pending partition. Callers diff it against the DB-applied
   * set from `appliedMigrationsReader`.
   */
  private async listOnDisk(): Promise<PendingMigration[]> {
    const files = await this.dirReader();
    const fileSet = new Set(files);
    const out: PendingMigration[] = [];
    for (const file of files) {
      const match = FORWARD_SQL_RE.exec(file);
      if (!match) continue; // skip down.sql, meta/, journal, etc.
      const id = assertSafeId(file.slice(0, -".sql".length));
      const reverseName = `${id}${REVERSE_SUFFIX}`;
      const hasReverse = fileSet.has(reverseName);
      out.push({
        id,
        forwardSqlPath: safeJoin(this.repoDir, this.migrationsDir, file),
        reverseSqlPath: hasReverse
          ? safeJoin(this.repoDir, this.migrationsDir, reverseName)
          : undefined,
        hasReverse,
      });
    }
    out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return out;
  }

  /**
   * Applied = on-disk forward migrations whose tag the DB reports as applied
   * (via `appliedMigrationsReader`). Id-ascending. Intersecting with the on-disk
   * listing guarantees every returned migration could have a committed `down.sql`
   * to reverse. These are the candidates `migrateReverse` may roll back — never
   * the pending set.
   */
  private async discoverApplied(): Promise<PendingMigration[]> {
    const [onDisk, appliedTags] = await Promise.all([
      this.listOnDisk(),
      this.appliedMigrationsReader(),
    ]);
    return onDisk.filter((m) => appliedTags.has(m.id));
  }

  /**
   * Pending = on-disk forward migrations whose tag the DB does NOT report as
   * applied. Id-ascending. This is the set `migrateForward` applies and the ONLY
   * set its failure-reverse may touch — already-applied migrations are excluded so
   * a forward failure can never wipe rows the DB already holds. An empty applied
   * set means every on-disk migration is pending (fresh DB).
   */
  private async discoverPending(): Promise<PendingMigration[]> {
    const [onDisk, appliedTags] = await Promise.all([
      this.listOnDisk(),
      this.appliedMigrationsReader(),
    ]);
    return onDisk.filter((m) => !appliedTags.has(m.id));
  }

  /** Default dirReader: plain listing of the migrations dir (file names only). */
  private async defaultDirReader(): Promise<readonly string[]> {
    const dir = `${this.repoDir}/${this.migrationsDir}`;
    // drizzle-kit owns generation; we only read the directory it produced.
    const glob = new Bun.Glob("*");
    const names: string[] = [];
    for await (const entry of glob.scan({ cwd: dir, onlyFiles: true })) {
      names.push(entry);
    }
    return names;
  }

  /**
   * Best-effort reverse used after a forward failure. Reverts the given
   * migrations (newest first) that have a `down.sql`, swallowing every error so
   * the original forward failure is never masked. Skips those without a down.sql.
   */
  private async reverseBestEffort(migrations: readonly PendingMigration[]): Promise<void> {
    const ordered = [...migrations].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    for (const m of ordered) {
      if (!m.hasReverse || !m.reverseSqlPath) {
        this.logger?.warn?.("MigrationCoordinator: cannot best-effort reverse — no down.sql", {
          id: m.id,
        });
        continue;
      }
      try {
        await this.sqlExecutor(m.reverseSqlPath);
        this.logger?.info?.("MigrationCoordinator: best-effort reverted", { id: m.id });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger?.warn?.("MigrationCoordinator: best-effort reverse failed", {
          id: m.id,
          error: msg,
        });
      }
    }
  }
}

export function createMigrationCoordinator(
  options: MigrationCoordinatorOptions,
): MigrationCoordinator {
  return new MigrationCoordinator(options);
}
