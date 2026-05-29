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
 * All I/O (the drizzle-kit subprocess, the forward apply, reverse SQL execution,
 * filesystem reads) is injectable so the core logic is unit-testable without a
 * real database, drizzle-kit binary, or disk. The default forward apply wraps
 * cap-migration's `runMigrations(db)`; the default reverse SQL executor wraps
 * cap-migration's `runReverseMigration(db, { sqlPath })`. The coordinator itself
 * stays DB-agnostic via the injected runners.
 *
 * This engine is intentionally DECOUPLED from BlueGreenDeployer and
 * DeployRollbackOrchestrator — wiring it into the deploy path is a later concern.
 * It never throws on operational failure: it returns `{ success: false, phase }`.
 */

import type { Logger } from "../types/logger";

// ── Types ────────────────────────────────────────────────────────────────

export interface MigrationRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Async runner for the `drizzle-kit` binary. Args are passed verbatim, no shell. */
export type DrizzleKitRunner = (
  args: readonly string[],
  options: { cwd: string },
) => Promise<MigrationRunResult>;

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
 * Read the set of already-applied migration tags from drizzle's journal.
 *
 * Drizzle records applied migrations in `<migrationsDir>/meta/_journal.json`
 * as `{ entries: [{ idx, version, when, tag }] }`, where `tag` is the migration
 * filename stem (e.g. "0001_greedy_king_bedlam"). The coordinator diffs this
 * against the on-disk dir listing to compute the genuinely-pending set.
 *
 * Injectable so tests feed a canned journal without touching disk. The default
 * reads + parses the journal file, gracefully treating a missing/empty/malformed
 * journal as "nothing applied yet" (fresh DB) — never throws.
 */
export type JournalReader = () => Promise<ReadonlySet<string>>;

/** Shape of a single drizzle journal entry we care about. */
interface DrizzleJournalEntry {
  tag: string;
}

/** Shape of the drizzle `_journal.json` we consume. */
interface DrizzleJournal {
  entries?: readonly DrizzleJournalEntry[];
}

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
  /** Injectable drizzle-kit runner for tests. Default: Bun.spawn. */
  drizzleKitRunner?: DrizzleKitRunner;
  /** Injectable forward apply. Default: cap-migration runMigrations(db). */
  forwardApply?: ForwardApplyRunner;
  /** Injectable reverse SQL executor. Default: cap-migration runReverseMigration. */
  sqlExecutor?: SqlExecutor;
  /** Injectable migrations-dir reader. Default: drizzle migrations dir listing. */
  dirReader?: MigrationDirReader;
  /**
   * Injectable reader of the applied-migration tag set from drizzle's journal.
   * Default: reads `<migrationsDir>/meta/_journal.json`. A missing/empty journal
   * means "nothing applied yet" (fresh DB).
   */
  journalReader?: JournalReader;
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
/** Drizzle's journal lives under `<migrationsDir>/meta/_journal.json`. */
const JOURNAL_RELATIVE_PATH = "meta/_journal.json";

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

// ── Default runners ──────────────────────────────────────────────────────

const defaultDrizzleKitRunner: DrizzleKitRunner = async (args, options) => {
  // CLAUDE.md: invoke drizzle-kit via the local bin, NOT bunx (EPIPE on macOS).
  const proc = Bun.spawn({
    cmd: ["bun", "./node_modules/.bin/drizzle-kit", ...args],
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
};

// ── MigrationCoordinator ───────────────────────────────────────────────────

export class MigrationCoordinator {
  private readonly repoDir: string;
  private readonly migrationsDir: string;
  private readonly dryRun: boolean;
  private readonly allowIrreversible: boolean;
  private readonly drizzleKitRunner: DrizzleKitRunner;
  private readonly forwardApply: ForwardApplyRunner;
  private readonly sqlExecutor: SqlExecutor;
  private readonly dirReader: MigrationDirReader;
  private readonly journalReader: JournalReader;
  private readonly classifyRelease: () => MigrationReleaseType | Promise<MigrationReleaseType>;
  private readonly logger?: Logger;
  private readonly clock: () => number;

  constructor(options: MigrationCoordinatorOptions) {
    this.repoDir = options.repoDir;
    this.migrationsDir = options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
    this.dryRun = options.dryRun ?? false;
    this.allowIrreversible = options.allowIrreversible ?? false;
    this.drizzleKitRunner = options.drizzleKitRunner ?? defaultDrizzleKitRunner;
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
    this.journalReader = options.journalReader ?? this.defaultJournalReader.bind(this);
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
   * "Pending" is computed by diffing the on-disk migrations against drizzle's
   * journal, so it is ONLY the not-yet-applied set. On `dryRun`, forwardApply is
   * NEVER called — returns `phase:"done"` with no applied ids. On success, returns
   * `phase:"done"`.
   *
   * On failure, performs a best-effort reverse of EXACTLY the pending migrations
   * this run attempted (those that have a committed `down.sql`), newest → oldest,
   * never masking the original error, and returns `phase:"aborted", success:false`.
   *
   * CRITICAL safety guarantee: already-applied migrations (those recorded in the
   * journal before this run) are NEVER in `pending`, so a forward failure can
   * never run their `down.sql` and wipe data the journal already accounts for.
   * Never throws on operational failure.
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
    // best-effort reverse of EXACTLY those (the journal-diffed pending set —
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
   * Reverse applied (journal-recorded) migrations by executing their committed
   * `down.sql` in newest → oldest id order via `sqlExecutor`.
   *
   * `targetId` semantics — EXCLUSIVE floor (the intuitive `migrate:down --to <id>`
   * contract): every applied migration STRICTLY NEWER than `targetId` is reverted;
   * `targetId` itself and everything older are KEPT. After the call the DB sits at
   * `targetId`. Omit `targetId` to revert all applied migrations (back to a fresh
   * DB). If `targetId` is supplied but is not among the applied migrations, the
   * call is rejected (`success:false`, nothing executed) rather than silently
   * rolling everything back.
   *
   * Only journal-recorded migrations are ever considered — pending (not-yet-
   * applied) migrations are never reverted here.
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
      // "applied" = migrations present on disk (journal-backed); reverse the
      // newest first. discoverApplied returns id-ascending; we reverse below.
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
   * the applied nor the pending partition. Callers diff it against the journal.
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
   * Applied = on-disk forward migrations whose tag IS recorded in the drizzle
   * journal (`<migrationsDir>/meta/_journal.json`). Id-ascending. These are the
   * candidates `migrateReverse` may roll back — never the pending set.
   */
  private async discoverApplied(): Promise<PendingMigration[]> {
    const [onDisk, appliedTags] = await Promise.all([this.listOnDisk(), this.journalReader()]);
    return onDisk.filter((m) => appliedTags.has(m.id));
  }

  /**
   * Pending = on-disk forward migrations whose tag is NOT recorded in the drizzle
   * journal. Id-ascending. This is the set `migrateForward` applies and the ONLY
   * set its failure-reverse may touch — already-applied migrations are excluded so
   * a forward failure can never wipe rows the journal already accounts for. A
   * missing/empty journal means every on-disk migration is pending (fresh DB).
   */
  private async discoverPending(): Promise<PendingMigration[]> {
    const [onDisk, appliedTags] = await Promise.all([this.listOnDisk(), this.journalReader()]);
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
   * Default journalReader: parse `<migrationsDir>/meta/_journal.json` into the
   * set of applied `tag`s. A missing, empty, or malformed journal yields an empty
   * set ("nothing applied yet" — fresh DB). Never throws: a broken journal must
   * not block discovery, it just makes every on-disk migration look pending.
   */
  private async defaultJournalReader(): Promise<ReadonlySet<string>> {
    const journalPath = `${this.repoDir}/${this.migrationsDir}/${JOURNAL_RELATIVE_PATH}`;
    try {
      const file = Bun.file(journalPath);
      if (!(await file.exists())) {
        this.logger?.debug?.("MigrationCoordinator: no journal — treating DB as fresh", {
          journalPath,
        });
        return new Set<string>();
      }
      const raw = (await file.text()).trim();
      if (raw.length === 0) {
        return new Set<string>();
      }
      const parsed = JSON.parse(raw) as DrizzleJournal;
      const tags = new Set<string>();
      for (const entry of parsed.entries ?? []) {
        if (typeof entry?.tag === "string" && entry.tag.length > 0) {
          tags.add(entry.tag);
        }
      }
      return tags;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger?.warn?.("MigrationCoordinator: could not read journal — treating DB as fresh", {
        journalPath,
        error: msg,
      });
      return new Set<string>();
    }
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
