import { describe, expect, it } from "bun:test";
import {
  createMigrationCoordinator,
  type DrizzleKitRunner,
  type JournalReader,
  MigrationCoordinator,
  type MigrationCoordinatorOptions,
  type MigrationDirReader,
  type MigrationReleaseType,
  type SqlExecutor,
} from "../src/deployment/migration-coordinator";

const REPO_DIR = "/tmp/fake-repo";
const MIGRATIONS_DIR = "drizzle/migrations";
const FIXED_CLOCK = () => 1_000_000;

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ── Helpers ───────────────────────────────────────────────────────────────

/** dirReader that returns a fixed set of file names under the migrations dir. */
function dirReaderOf(...files: string[]): MigrationDirReader {
  return async () => files;
}

/**
 * journalReader that reports the given migration tags as already applied. With
 * no args it reports "nothing applied yet" (fresh DB).
 */
function journalOf(...tags: string[]): JournalReader {
  return async () => new Set(tags);
}

/** An sqlExecutor that records the order of paths executed; never fails. */
function recordingExecutor(log: string[]): SqlExecutor {
  return async (sqlPath) => {
    log.push(sqlPath);
  };
}

function absPath(file: string): string {
  return `${REPO_DIR}/${MIGRATIONS_DIR}/${file}`;
}

/**
 * Default test options. By default the journal is EMPTY (fresh DB) so every
 * on-disk migration is pending — matching the original "all files are pending"
 * assumption of the forward/preFlight suites. Reverse tests that need migrations
 * to be applied override `journalReader` explicitly.
 */
function baseOpts(
  overrides: Partial<MigrationCoordinatorOptions> = {},
): MigrationCoordinatorOptions {
  return {
    repoDir: REPO_DIR,
    migrationsDir: MIGRATIONS_DIR,
    logger: silentLogger,
    clock: FIXED_CLOCK,
    journalReader: journalOf(),
    ...overrides,
  };
}

// ── Constructor / factory ──────────────────────────────────────────────────

describe("MigrationCoordinator — constructor & factory", () => {
  it("constructs with defaults", () => {
    const c = new MigrationCoordinator({ repoDir: REPO_DIR });
    expect(c).toBeInstanceOf(MigrationCoordinator);
  });

  it("factory creates an instance", () => {
    const c = createMigrationCoordinator({ repoDir: REPO_DIR });
    expect(c).toBeInstanceOf(MigrationCoordinator);
  });
});

// ── preFlight ───────────────────────────────────────────────────────────────

describe("MigrationCoordinator — preFlight", () => {
  it("returns ok with no pending migrations", async () => {
    const c = createMigrationCoordinator(baseOpts({ dirReader: dirReaderOf() }));
    const result = await c.preFlight();
    expect(result.ok).toBe(true);
    expect(result.pending).toHaveLength(0);
    expect(result.reversibleAll).toBe(true);
    expect(result.blockers).toHaveLength(0);
  });

  it("is ok when every pending migration has a sibling down.sql", async () => {
    const c = createMigrationCoordinator(
      baseOpts({
        dirReader: dirReaderOf("0007_a.sql", "0007_a.down.sql", "0008_b.sql", "0008_b.down.sql"),
        classifyRelease: () => "expand",
      }),
    );
    const result = await c.preFlight();
    expect(result.ok).toBe(true);
    expect(result.reversibleAll).toBe(true);
    expect(result.pending.map((m) => m.id)).toEqual(["0007_a", "0008_b"]);
    expect(result.pending.every((m) => m.hasReverse)).toBe(true);
    expect(result.pending[0]?.reverseSqlPath).toBe(absPath("0007_a.down.sql"));
  });

  it("blocks (ok=false) when a pending migration lacks down.sql and allowIrreversible is false", async () => {
    const c = createMigrationCoordinator(
      baseOpts({
        dirReader: dirReaderOf("0007_a.sql", "0008_b.sql", "0008_b.down.sql"),
      }),
    );
    const result = await c.preFlight();
    expect(result.ok).toBe(false);
    expect(result.reversibleAll).toBe(false);
    expect(result.blockers.some((b) => b.includes("0007_a"))).toBe(true);
  });

  it("clears the irreversibility blocker when allowIrreversible is true (manual confirmation)", async () => {
    const c = createMigrationCoordinator(
      baseOpts({
        dirReader: dirReaderOf("0007_a.sql"),
        allowIrreversible: true,
      }),
    );
    const result = await c.preFlight();
    expect(result.ok).toBe(true);
    expect(result.reversibleAll).toBe(false);
    expect(result.warnings.some((w) => w.includes("Manually confirmed"))).toBe(true);
  });

  it("blocks on a breaking release even when down.sql exists", async () => {
    const c = createMigrationCoordinator(
      baseOpts({
        dirReader: dirReaderOf("0007_a.sql", "0007_a.down.sql"),
        classifyRelease: (): MigrationReleaseType => "breaking",
      }),
    );
    const result = await c.preFlight();
    expect(result.ok).toBe(false);
    expect(result.blockers.some((b) => /breaking/i.test(b))).toBe(true);
  });

  it("warns (but stays ok) on a contract release", async () => {
    const c = createMigrationCoordinator(
      baseOpts({
        dirReader: dirReaderOf("0007_a.sql", "0007_a.down.sql"),
        classifyRelease: (): MigrationReleaseType => "contract",
      }),
    );
    const result = await c.preFlight();
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => /contract/i.test(w))).toBe(true);
    expect(result.blockers).toHaveLength(0);
  });

  it("dryRun does not call forwardApply", async () => {
    let forwardCalls = 0;
    const c = createMigrationCoordinator(
      baseOpts({
        dryRun: true,
        dirReader: dirReaderOf("0007_a.sql", "0007_a.down.sql"),
        forwardApply: async () => {
          forwardCalls++;
        },
      }),
    );
    await c.preFlight();
    const fwd = await c.migrateForward();
    expect(forwardCalls).toBe(0);
    expect(fwd.success).toBe(true);
    expect(fwd.phase).toBe("done");
    expect(fwd.applied).toHaveLength(0);
  });

  it("ignores non-migration files (down.sql, meta, journal)", async () => {
    const c = createMigrationCoordinator(
      baseOpts({
        dirReader: dirReaderOf(
          "0007_a.sql",
          "0007_a.down.sql",
          "_journal.json",
          "meta",
          "README.md",
        ),
      }),
    );
    const result = await c.preFlight();
    expect(result.pending.map((m) => m.id)).toEqual(["0007_a"]);
  });
});

// ── migrateForward ──────────────────────────────────────────────────────────

describe("MigrationCoordinator — migrateForward", () => {
  it("calls forwardApply once and returns done with applied ids", async () => {
    let forwardCalls = 0;
    const c = createMigrationCoordinator(
      baseOpts({
        dirReader: dirReaderOf("0007_a.sql", "0007_a.down.sql", "0008_b.sql", "0008_b.down.sql"),
        forwardApply: async () => {
          forwardCalls++;
        },
      }),
    );
    const result = await c.migrateForward();
    expect(forwardCalls).toBe(1);
    expect(result.success).toBe(true);
    expect(result.phase).toBe("done");
    expect(result.direction).toBe("forward");
    expect(result.applied).toEqual(["0007_a", "0008_b"]);
  });

  it("aborts and attempts reverse when forwardApply rejects (never throws)", async () => {
    const reverseLog: string[] = [];
    const c = createMigrationCoordinator(
      baseOpts({
        dirReader: dirReaderOf("0007_a.sql", "0007_a.down.sql", "0008_b.sql", "0008_b.down.sql"),
        forwardApply: async () => {
          throw new Error("apply blew up");
        },
        sqlExecutor: recordingExecutor(reverseLog),
      }),
    );
    const result = await c.migrateForward();
    expect(result.success).toBe(false);
    expect(result.phase).toBe("aborted");
    expect(result.error).toContain("apply blew up");
    // Best-effort reverse runs newest → oldest, only for migrations with down.sql.
    expect(reverseLog).toEqual([absPath("0008_b.down.sql"), absPath("0007_a.down.sql")]);
  });

  it("does not throw even when the best-effort reverse itself fails", async () => {
    const c = createMigrationCoordinator(
      baseOpts({
        dirReader: dirReaderOf("0007_a.sql", "0007_a.down.sql"),
        forwardApply: async () => {
          throw new Error("apply blew up");
        },
        sqlExecutor: async () => {
          throw new Error("reverse also blew up");
        },
      }),
    );
    const result = await c.migrateForward();
    expect(result.success).toBe(false);
    expect(result.phase).toBe("aborted");
    // Original error is preserved, not masked by the reverse failure.
    expect(result.error).toContain("apply blew up");
  });

  it("skips reverse of migrations without a down.sql during best-effort", async () => {
    const reverseLog: string[] = [];
    const c = createMigrationCoordinator(
      baseOpts({
        // allowIrreversible so forward can still proceed; 0007 has no down.sql.
        allowIrreversible: true,
        dirReader: dirReaderOf("0007_a.sql", "0008_b.sql", "0008_b.down.sql"),
        forwardApply: async () => {
          throw new Error("boom");
        },
        sqlExecutor: recordingExecutor(reverseLog),
      }),
    );
    const result = await c.migrateForward();
    expect(result.phase).toBe("aborted");
    expect(reverseLog).toEqual([absPath("0008_b.down.sql")]);
  });
});

// ── journal-awareness (applied vs pending) ───────────────────────────────────

describe("MigrationCoordinator — journal-awareness", () => {
  // The full on-disk set: 100 already-applied migrations (0000..0099, each with a
  // down.sql) + 1 genuinely-new pending migration (0100, also with a down.sql).
  function bigOnDisk(): MigrationDirReader {
    const files: string[] = [];
    for (let i = 0; i <= 100; i++) {
      const id = `${String(i).padStart(4, "0")}_m${i}`;
      files.push(`${id}.sql`, `${id}.down.sql`);
    }
    return dirReaderOf(...files);
  }

  function appliedTags(count: number): string[] {
    const tags: string[] = [];
    for (let i = 0; i < count; i++) tags.push(`${String(i).padStart(4, "0")}_m${i}`);
    return tags;
  }

  it("preFlight.pending contains ONLY the not-applied on-disk migrations", async () => {
    const c = createMigrationCoordinator(
      baseOpts({
        dirReader: dirReaderOf(
          "0007_a.sql",
          "0007_a.down.sql",
          "0008_b.sql",
          "0008_b.down.sql",
          "0009_c.sql",
          "0009_c.down.sql",
        ),
        // 0007 + 0008 already applied; only 0009 is pending.
        journalReader: journalOf("0007_a", "0008_b"),
      }),
    );
    const result = await c.preFlight();
    expect(result.pending.map((m) => m.id)).toEqual(["0009_c"]);
    expect(result.ok).toBe(true);
  });

  it("an already-applied migration missing its down.sql does NOT set a blocker", async () => {
    const c = createMigrationCoordinator(
      baseOpts({
        // 0007 is APPLIED but has NO down.sql — it must NOT block future releases.
        // 0008 is pending and fully reversible.
        dirReader: dirReaderOf("0007_a.sql", "0008_b.sql", "0008_b.down.sql"),
        journalReader: journalOf("0007_a"),
      }),
    );
    const result = await c.preFlight();
    expect(result.pending.map((m) => m.id)).toEqual(["0008_b"]);
    expect(result.ok).toBe(true);
    expect(result.reversibleAll).toBe(true);
    expect(result.blockers).toHaveLength(0);
    // The applied, irreversible migration is never mentioned as a blocker.
    expect(result.blockers.some((b) => b.includes("0007_a"))).toBe(false);
  });

  it("a PENDING migration missing its down.sql still blocks (policy intact)", async () => {
    const c = createMigrationCoordinator(
      baseOpts({
        // 0007 applied + reversible; 0008 pending WITHOUT a down.sql → blocker.
        dirReader: dirReaderOf("0007_a.sql", "0007_a.down.sql", "0008_b.sql"),
        journalReader: journalOf("0007_a"),
      }),
    );
    const result = await c.preFlight();
    expect(result.pending.map((m) => m.id)).toEqual(["0008_b"]);
    expect(result.ok).toBe(false);
    expect(result.blockers.some((b) => b.includes("0008_b"))).toBe(true);
  });

  // 🔴 CRITICAL regression: a forward failure with 100 applied + 1 pending must
  // ONLY reverse the 1 pending migration's down.sql — NEVER touch any applied
  // migration's down.sql (that would wipe the whole DB).
  it("migrateForward failure reverses ONLY the pending migration, never the applied ones", async () => {
    const reverseLog: string[] = [];
    const c = createMigrationCoordinator(
      baseOpts({
        dirReader: bigOnDisk(),
        journalReader: journalOf(...appliedTags(100)), // 0000..0099 applied
        forwardApply: async () => {
          throw new Error("apply blew up");
        },
        sqlExecutor: recordingExecutor(reverseLog),
      }),
    );
    const result = await c.migrateForward();
    expect(result.success).toBe(false);
    expect(result.phase).toBe("aborted");
    expect(result.error).toContain("apply blew up");
    // EXACTLY one down.sql executed — the pending 0100 only.
    expect(reverseLog).toEqual([absPath("0100_m100.down.sql")]);
    // Hard assertion: no applied migration's down.sql was ever executed.
    for (let i = 0; i < 100; i++) {
      const downName = `${String(i).padStart(4, "0")}_m${i}.down.sql`;
      expect(reverseLog).not.toContain(absPath(downName));
    }
  });

  it("forward success applies ONLY the pending ids (not the whole journal)", async () => {
    const c = createMigrationCoordinator(
      baseOpts({
        dirReader: dirReaderOf(
          "0007_a.sql",
          "0007_a.down.sql",
          "0008_b.sql",
          "0008_b.down.sql",
          "0009_c.sql",
          "0009_c.down.sql",
        ),
        journalReader: journalOf("0007_a", "0008_b"),
        forwardApply: async () => {},
      }),
    );
    const result = await c.migrateForward();
    expect(result.success).toBe(true);
    expect(result.applied).toEqual(["0009_c"]);
  });

  it("missing/empty journal treats all on-disk migrations as pending (fresh DB)", async () => {
    const c = createMigrationCoordinator(
      baseOpts({
        dirReader: dirReaderOf("0007_a.sql", "0007_a.down.sql", "0008_b.sql", "0008_b.down.sql"),
        // journalReader returns an empty set → nothing applied yet.
        journalReader: journalOf(),
      }),
    );
    const result = await c.preFlight();
    expect(result.pending.map((m) => m.id)).toEqual(["0007_a", "0008_b"]);
    expect(result.ok).toBe(true);
  });

  it("when everything on disk is already applied, nothing is pending", async () => {
    const c = createMigrationCoordinator(
      baseOpts({
        dirReader: dirReaderOf("0007_a.sql", "0007_a.down.sql", "0008_b.sql", "0008_b.down.sql"),
        journalReader: journalOf("0007_a", "0008_b"),
        forwardApply: async () => {},
      }),
    );
    const pre = await c.preFlight();
    expect(pre.pending).toHaveLength(0);
    expect(pre.ok).toBe(true);
    const fwd = await c.migrateForward();
    expect(fwd.success).toBe(true);
    expect(fwd.applied).toHaveLength(0);
  });
});

// ── migrateReverse ──────────────────────────────────────────────────────────

describe("MigrationCoordinator — migrateReverse", () => {
  it("executes down.sql in reverse id order via sqlExecutor", async () => {
    const reverseLog: string[] = [];
    const c = createMigrationCoordinator(
      baseOpts({
        dirReader: dirReaderOf(
          "0007_a.sql",
          "0007_a.down.sql",
          "0008_b.sql",
          "0008_b.down.sql",
          "0009_c.sql",
          "0009_c.down.sql",
        ),
        journalReader: journalOf("0007_a", "0008_b", "0009_c"),
        sqlExecutor: recordingExecutor(reverseLog),
      }),
    );
    const result = await c.migrateReverse();
    expect(result.success).toBe(true);
    expect(result.phase).toBe("done");
    expect(result.direction).toBe("reverse");
    expect(result.applied).toEqual(["0009_c", "0008_b", "0007_a"]);
    expect(reverseLog).toEqual([
      absPath("0009_c.down.sql"),
      absPath("0008_b.down.sql"),
      absPath("0007_a.down.sql"),
    ]);
  });

  it("refuses partial execution when a down.sql is missing (no statements run)", async () => {
    const reverseLog: string[] = [];
    const c = createMigrationCoordinator(
      baseOpts({
        // 0008 has no down.sql.
        dirReader: dirReaderOf("0007_a.sql", "0007_a.down.sql", "0008_b.sql"),
        journalReader: journalOf("0007_a", "0008_b"),
        sqlExecutor: recordingExecutor(reverseLog),
      }),
    );
    const result = await c.migrateReverse();
    expect(result.success).toBe(false);
    expect(result.phase).toBe("failed");
    expect(result.error).toContain("0008_b");
    expect(reverseLog).toHaveLength(0);
  });

  it("stops at targetId — exclusive floor (target itself kept)", async () => {
    const reverseLog: string[] = [];
    const c = createMigrationCoordinator(
      baseOpts({
        dirReader: dirReaderOf(
          "0007_a.sql",
          "0007_a.down.sql",
          "0008_b.sql",
          "0008_b.down.sql",
          "0009_c.sql",
          "0009_c.down.sql",
        ),
        journalReader: journalOf("0007_a", "0008_b", "0009_c"),
        sqlExecutor: recordingExecutor(reverseLog),
      }),
    );
    const result = await c.migrateReverse("0007_a");
    expect(result.success).toBe(true);
    expect(result.applied).toEqual(["0009_c", "0008_b"]);
    expect(reverseLog).toEqual([absPath("0009_c.down.sql"), absPath("0008_b.down.sql")]);
  });

  it("returns done with nothing reverted when targetId is the newest", async () => {
    const reverseLog: string[] = [];
    const c = createMigrationCoordinator(
      baseOpts({
        dirReader: dirReaderOf("0007_a.sql", "0007_a.down.sql", "0008_b.sql", "0008_b.down.sql"),
        journalReader: journalOf("0007_a", "0008_b"),
        sqlExecutor: recordingExecutor(reverseLog),
      }),
    );
    const result = await c.migrateReverse("0008_b");
    expect(result.success).toBe(true);
    expect(result.applied).toHaveLength(0);
    expect(reverseLog).toHaveLength(0);
  });

  it("rejects an unknown targetId rather than reverting everything", async () => {
    const reverseLog: string[] = [];
    const c = createMigrationCoordinator(
      baseOpts({
        dirReader: dirReaderOf("0007_a.sql", "0007_a.down.sql", "0008_b.sql", "0008_b.down.sql"),
        journalReader: journalOf("0007_a", "0008_b"),
        sqlExecutor: recordingExecutor(reverseLog),
      }),
    );
    const result = await c.migrateReverse("0099_nope");
    expect(result.success).toBe(false);
    expect(result.phase).toBe("failed");
    expect(result.error).toContain("0099_nope");
    expect(reverseLog).toHaveLength(0);
  });

  it("aborts (not partial-clean) when an sqlExecutor call rejects mid-run", async () => {
    const reverseLog: string[] = [];
    const c = createMigrationCoordinator(
      baseOpts({
        dirReader: dirReaderOf(
          "0007_a.sql",
          "0007_a.down.sql",
          "0008_b.sql",
          "0008_b.down.sql",
          "0009_c.sql",
          "0009_c.down.sql",
        ),
        journalReader: journalOf("0007_a", "0008_b", "0009_c"),
        sqlExecutor: async (sqlPath) => {
          reverseLog.push(sqlPath);
          if (sqlPath.includes("0008_b")) throw new Error("down failed");
        },
      }),
    );
    const result = await c.migrateReverse();
    expect(result.success).toBe(false);
    expect(result.phase).toBe("aborted");
    expect(result.error).toContain("0008_b");
    // 0009 reverted before the failure on 0008.
    expect(result.applied).toEqual(["0009_c"]);
  });
});

// ── arg / path injection rejection ──────────────────────────────────────────

describe("MigrationCoordinator — injection rejection", () => {
  it("rejects a targetId starting with '-'", async () => {
    const c = createMigrationCoordinator(
      baseOpts({ dirReader: dirReaderOf("0007_a.sql", "0007_a.down.sql") }),
    );
    const result = await c.migrateReverse("--force");
    expect(result.success).toBe(false);
    expect(result.phase).toBe("failed");
    expect(result.error).toMatch(/must not start with '-'|invalid migration id/);
  });

  it("rejects a targetId containing a path separator", async () => {
    const c = createMigrationCoordinator(
      baseOpts({ dirReader: dirReaderOf("0007_a.sql", "0007_a.down.sql") }),
    );
    const result = await c.migrateReverse("../../etc/passwd");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/invalid migration id|must not start with/);
  });

  it("rejects a migration file name with traversal during discovery", async () => {
    // A maliciously-crafted dir listing entry with a traversal-laden name must
    // never become a reverted migration. It does not match FORWARD_SQL_RE
    // (slash present) so discovery silently skips it — only the legitimate
    // migration (which has a down.sql) is reversible.
    const reverseLog: string[] = [];
    const c = createMigrationCoordinator(
      baseOpts({
        dirReader: dirReaderOf("0007_a.sql", "0007_a.down.sql", "0007_a/../evil.sql"),
        journalReader: journalOf("0007_a"),
        sqlExecutor: recordingExecutor(reverseLog),
      }),
    );
    const result = await c.migrateReverse();
    expect(result.success).toBe(true);
    expect(result.applied).toEqual(["0007_a"]);
    // Only the legitimate down.sql was executed; the traversal entry never reached the executor.
    expect(reverseLog).toEqual([absPath("0007_a.down.sql")]);
  });
});

// ── default runners are wired (no accidental real-IO at construct time) ──────

describe("MigrationCoordinator — defaults", () => {
  it("default forwardApply throws a descriptive error when not injected", async () => {
    const c = createMigrationCoordinator({
      repoDir: REPO_DIR,
      migrationsDir: MIGRATIONS_DIR,
      logger: silentLogger,
      clock: FIXED_CLOCK,
      dirReader: dirReaderOf("0007_a.sql", "0007_a.down.sql"),
    });
    const result = await c.migrateForward();
    // forwardApply default throws → caught → aborted; reverse is best-effort but
    // the default sqlExecutor also throws, which is swallowed.
    expect(result.success).toBe(false);
    expect(result.phase).toBe("aborted");
    expect(result.error).toContain("no forwardApply provided");
  });

  it("does not invoke the drizzle-kit runner during pre-flight (read-only)", async () => {
    let kitCalls = 0;
    const drizzleKitRunner: DrizzleKitRunner = async () => {
      kitCalls++;
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const c = createMigrationCoordinator(
      baseOpts({ dirReader: dirReaderOf("0007_a.sql", "0007_a.down.sql"), drizzleKitRunner }),
    );
    await c.preFlight();
    expect(kitCalls).toBe(0);
  });

  it("default journalReader treats a missing journal as a fresh DB (everything pending)", async () => {
    // No journalReader injected → the real default reads /tmp/fake-repo/.../meta/
    // _journal.json which does not exist → empty applied set → all on-disk pending.
    const c = createMigrationCoordinator({
      repoDir: REPO_DIR,
      migrationsDir: MIGRATIONS_DIR,
      logger: silentLogger,
      clock: FIXED_CLOCK,
      dirReader: dirReaderOf("0007_a.sql", "0007_a.down.sql", "0008_b.sql", "0008_b.down.sql"),
    });
    const result = await c.preFlight();
    expect(result.pending.map((m) => m.id)).toEqual(["0007_a", "0008_b"]);
    expect(result.ok).toBe(true);
  });

  it("default journalReader parses a real drizzle _journal.json from disk", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const root = mkdtempSync(`${tmpdir()}/mig-coord-`);
    try {
      const metaDir = `${root}/${MIGRATIONS_DIR}/meta`;
      mkdirSync(metaDir, { recursive: true });
      writeFileSync(
        `${metaDir}/_journal.json`,
        JSON.stringify({
          version: "7",
          dialect: "postgresql",
          entries: [
            { idx: 0, version: "7", when: 1, tag: "0007_a", breakpoints: true },
            // 0008_b deliberately NOT in the journal → pending.
          ],
        }),
      );
      const c = createMigrationCoordinator({
        repoDir: root,
        migrationsDir: MIGRATIONS_DIR,
        logger: silentLogger,
        clock: FIXED_CLOCK,
        // dirReader injected so we don't depend on writing the .sql files too.
        dirReader: dirReaderOf("0007_a.sql", "0007_a.down.sql", "0008_b.sql", "0008_b.down.sql"),
      });
      const result = await c.preFlight();
      // 0007_a is in the journal → applied; only 0008_b is pending.
      expect(result.pending.map((m) => m.id)).toEqual(["0008_b"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
