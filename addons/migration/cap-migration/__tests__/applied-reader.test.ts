import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAppliedMigrationsReader, type MigrationStateDb } from "../src/applied-reader";

// ── Fixtures ────────────────────────────────────────────────────────────────

/**
 * A fixture journal mirroring drizzle's `meta/_journal.json` shape. Each entry's
 * `when` is what drizzle-orm writes into `__drizzle_migrations.created_at`
 * (`folderMillis`), and `tag` is the migration id the coordinator partitions on.
 */
const JOURNAL = {
  version: "7",
  dialect: "postgresql",
  entries: [
    { idx: 0, version: "7", when: 1775376040980, tag: "0000_melted_gateway", breakpoints: true },
    { idx: 1, version: "7", when: 1775733762343, tag: "0001_greedy_king", breakpoints: true },
    { idx: 2, version: "7", when: 1777128126634, tag: "0002_loving_kang", breakpoints: true },
  ],
};

let migrationsDir: string;

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "cap-migration-reader-"));
  migrationsDir = join(root, "drizzle", "migrations");
  await Bun.write(join(migrationsDir, "meta", "_journal.json"), JSON.stringify(JOURNAL, null, 2));
});

afterAll(async () => {
  // migrationsDir = <root>/drizzle/migrations — clean up the whole temp root.
  await rm(join(migrationsDir, "..", ".."), { recursive: true, force: true });
});

// ── Fake DB helpers ─────────────────────────────────────────────────────────

/**
 * A fake `MigrationStateDb` whose `execute` returns canned object rows
 * (`{ created_at }`), mimicking drizzle/postgres.js. `created_at` is a STRING
 * because the column is `bigint` and postgres.js returns bigints as strings.
 */
function dbWithRows(...createdAt: Array<string | number | bigint>): MigrationStateDb {
  return {
    execute: (async () =>
      createdAt.map((value) => ({ created_at: value }))) as MigrationStateDb["execute"],
  };
}

/** A fake DB whose `execute` rejects with a given PG SQLSTATE code. */
function dbThrowing(code: string): MigrationStateDb {
  return {
    execute: (async () => {
      const err = new Error(`relation does not exist`) as Error & { code: string };
      err.code = code;
      throw err;
    }) as MigrationStateDb["execute"],
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("createAppliedMigrationsReader — maps DB rows → tags via journal", () => {
  it("maps each applied created_at to its journal tag", async () => {
    const reader = createAppliedMigrationsReader({
      db: dbWithRows("1775376040980", "1775733762343"),
      migrationsDir,
    });
    const applied = await reader();
    expect([...applied].sort()).toEqual(["0000_melted_gateway", "0001_greedy_king"]);
  });

  it("tolerates created_at as number or bigint, not only string", async () => {
    const reader = createAppliedMigrationsReader({
      db: dbWithRows(1775376040980, 1777128126634n),
      migrationsDir,
    });
    const applied = await reader();
    expect([...applied].sort()).toEqual(["0000_melted_gateway", "0002_loving_kang"]);
  });

  it("returns the full applied set when every row matches", async () => {
    const reader = createAppliedMigrationsReader({
      db: dbWithRows("1775376040980", "1775733762343", "1777128126634"),
      migrationsDir,
    });
    const applied = await reader();
    expect(applied.size).toBe(3);
  });
});

describe("createAppliedMigrationsReader — missing table → empty set", () => {
  it("returns empty set on undefined_table (42P01)", async () => {
    const reader = createAppliedMigrationsReader({ db: dbThrowing("42P01"), migrationsDir });
    const applied = await reader();
    expect(applied.size).toBe(0);
  });

  it("returns empty set on invalid_schema_name (3F000)", async () => {
    const reader = createAppliedMigrationsReader({ db: dbThrowing("3F000"), migrationsDir });
    const applied = await reader();
    expect(applied.size).toBe(0);
  });

  it("re-throws DB errors that are NOT a missing table", async () => {
    const reader = createAppliedMigrationsReader({ db: dbThrowing("08006"), migrationsDir });
    await expect(reader()).rejects.toThrow();
  });
});

describe("createAppliedMigrationsReader — unmatched rows are skipped", () => {
  it("skips a created_at with no matching journal entry", async () => {
    const reader = createAppliedMigrationsReader({
      // 1775376040980 matches 0000; 9999999999999 + the malformed entries don't.
      db: dbWithRows("1775376040980", "9999999999999", "not-a-number", ""),
      migrationsDir,
    });
    const applied = await reader();
    expect([...applied]).toEqual(["0000_melted_gateway"]);
  });

  it("returns empty set when no row matches any journal entry", async () => {
    const reader = createAppliedMigrationsReader({
      db: dbWithRows("1", "2", "3"),
      migrationsDir,
    });
    const applied = await reader();
    expect(applied.size).toBe(0);
  });
});

describe("createAppliedMigrationsReader — journal handling", () => {
  it("returns empty set when the journal is missing (never throws)", async () => {
    const reader = createAppliedMigrationsReader({
      db: dbWithRows("1775376040980"),
      migrationsDir: join(tmpdir(), "cap-migration-no-such-dir-xyz"),
    });
    const applied = await reader();
    expect(applied.size).toBe(0);
  });

  it("returns empty set when the journal is malformed (never throws)", async () => {
    const root = await mkdtemp(join(tmpdir(), "cap-migration-bad-journal-"));
    const badDir = join(root, "drizzle", "migrations");
    await Bun.write(join(badDir, "meta", "_journal.json"), "{ this is not json");
    try {
      const reader = createAppliedMigrationsReader({
        db: dbWithRows("1775376040980"),
        migrationsDir: badDir,
      });
      const applied = await reader();
      expect(applied.size).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not query the journal when the DB reports nothing applied", async () => {
    const reader = createAppliedMigrationsReader({ db: dbWithRows(), migrationsDir });
    const applied = await reader();
    expect(applied.size).toBe(0);
  });
});

describe("createAppliedMigrationsReader — positional tuple rows", () => {
  it("reads created_at from positional [value] rows too", async () => {
    const db: MigrationStateDb = {
      execute: (async () => [["1775376040980"], ["1775733762343"]]) as MigrationStateDb["execute"],
    };
    const reader = createAppliedMigrationsReader({ db, migrationsDir });
    const applied = await reader();
    expect([...applied].sort()).toEqual(["0000_melted_gateway", "0001_greedy_king"]);
  });
});
