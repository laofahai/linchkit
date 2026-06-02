/**
 * SystemDataProvider — watcher_state DB source integration tests (Spec 45 §7.1).
 *
 * Drives the REAL DB-backed `watcher_state` path of SystemDataProvider against a
 * real `_linchkit.watcher_state` table (the production debounce-state backend
 * shipped by Spec 45 PR-2), proving the admin management UI can list/count the
 * persisted per-(watcher, group) condition state.
 *
 * Mirrors the harness used by the cap-ai-provider DrizzleWatcherStateStore
 * integration suite: self-creates the `_linchkit.watcher_state` fixture table
 * (this is NOT production DDL — production DDL is delegated to drizzle-kit; the
 * shape mirrors src/watcher-state-table.ts).
 *
 * Requires a running PostgreSQL instance. Set DATABASE_TEST_URL to connect.
 * Default: postgres://linchkit_test:linchkit_test@localhost:5434/linchkit_test
 * Skips gracefully when no database is available; CI provides the `postgres`
 * service so this suite RUNS there.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { watcherStateTable } from "@linchkit/cap-ai-provider";
import { closeDatabase, createDatabase, InMemoryStore } from "@linchkit/core/server";
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { SystemDataProvider } from "../src/system-data-provider";

// ── Test configuration ───────────────────────────────────────

const DATABASE_URL =
  process.env.DATABASE_TEST_URL ??
  "postgres://linchkit_test:linchkit_test@localhost:5434/linchkit_test";

const TABLE = `"_linchkit"."watcher_state"`;

// ── Connection check ─────────────────────────────────────────

async function canConnect(): Promise<boolean> {
  try {
    const testDb = createDatabase({ url: DATABASE_URL });
    await testDb.execute(sql`SELECT 1`);
    return true;
  } catch {
    return false;
  } finally {
    await closeDatabase();
  }
}

const dbAvailable = await canConnect();

if (!dbAvailable) {
  console.warn(
    "PostgreSQL not available, skipping SystemDataProvider watcher_state integration tests",
  );
}

// ── Fixtures ─────────────────────────────────────────────────

let db: PostgresJsDatabase | null = null;

/**
 * Narrow `db` to non-null. Assigned in beforeAll; the suite is skipped when no
 * DB is available, so this never throws in practice. A clear error beats the
 * repo-banned `db!` non-null assertion (biome `noNonNullAssertion`).
 */
function requireDb(): PostgresJsDatabase {
  if (!db) throw new Error("db not initialized — beforeAll did not run");
  return db;
}

// ── Test suite ───────────────────────────────────────────────

describe.skipIf(!dbAvailable)("SystemDataProvider watcher_state (DB integration)", () => {
  beforeAll(async () => {
    db = createDatabase({ url: DATABASE_URL });

    await db.execute(sql.raw(`CREATE SCHEMA IF NOT EXISTS "_linchkit"`));

    // Self-create the fixture table mirroring src/watcher-state-table.ts. This
    // is NOT production DDL (drizzle-kit owns that) — it gives the real
    // SystemDataProvider an authentic schema to query against.
    await db.execute(sql.raw(`DROP TABLE IF EXISTS ${TABLE} CASCADE`));
    await db.execute(
      sql.raw(`
      CREATE TABLE ${TABLE} (
        "watcher_name" text NOT NULL,
        "group_key" text NOT NULL,
        "last_fired_at" timestamp,
        "condition_met" boolean DEFAULT false NOT NULL,
        "tenant_id" text,
        "updated_at" timestamp DEFAULT now() NOT NULL,
        CONSTRAINT "watcher_state_watcher_name_group_key_pk" PRIMARY KEY ("watcher_name", "group_key")
      )
    `),
    );
  });

  afterAll(async () => {
    if (db) {
      await db.execute(sql.raw(`DROP TABLE IF EXISTS ${TABLE} CASCADE`));
      await closeDatabase();
    }
  });

  beforeEach(async () => {
    if (db) {
      await db.execute(sql.raw(`TRUNCATE TABLE ${TABLE}`));
    }
  });

  function makeProvider(): SystemDataProvider {
    return new SystemDataProvider(new InMemoryStore(), { db: requireDb() });
  }

  async function seed(rows: Array<typeof watcherStateTable.$inferInsert>): Promise<void> {
    await requireDb().insert(watcherStateTable).values(rows);
  }

  test("query returns rows with snake_case fields and ISO timestamps", async () => {
    const firedAt = new Date("2026-02-02T03:04:05.000Z");
    await seed([
      {
        watcherName: "low-stock",
        groupKey: "item-1",
        lastFiredAt: firedAt,
        conditionMet: true,
        tenantId: "t1",
      },
    ]);

    const provider = makeProvider();
    const rows = await provider.query("watcher_state", {});
    expect(rows).toHaveLength(1);

    const record = rows[0];
    expect(record.watcher_name).toBe("low-stock");
    expect(record.group_key).toBe("item-1");
    expect(record.condition_met).toBe(true);
    expect(record.tenant_id).toBe("t1");
    // Timestamps serialized to ISO strings for GraphQL compatibility.
    expect(record.last_fired_at).toBe("2026-02-02T03:04:05.000Z");
    expect(typeof record.updated_at).toBe("string");
  });

  test("count returns total and supports filtering by a mapped column", async () => {
    await seed([
      { watcherName: "w1", groupKey: "a", conditionMet: true },
      { watcherName: "w1", groupKey: "b", conditionMet: false },
      { watcherName: "w2", groupKey: "a", conditionMet: true },
    ]);

    const provider = makeProvider();
    expect(await provider.count("watcher_state")).toBe(3);

    // Filter on a snake_case field that maps to a camelCase DB column.
    const filtered = await provider.query("watcher_state", { watcher_name: "w1" });
    expect(filtered).toHaveLength(2);
    expect(await provider.count("watcher_state", { watcher_name: "w1" })).toBe(2);
  });

  test("query sorts by updated_at desc and paginates", async () => {
    await seed([
      { watcherName: "w", groupKey: "g1", updatedAt: new Date("2026-01-01T00:00:00.000Z") },
      { watcherName: "w", groupKey: "g2", updatedAt: new Date("2026-03-01T00:00:00.000Z") },
      { watcherName: "w", groupKey: "g3", updatedAt: new Date("2026-02-01T00:00:00.000Z") },
    ]);

    const provider = makeProvider();
    const sorted = await provider.query("watcher_state", {
      sortField: "updated_at",
      sortOrder: "desc",
    });
    expect(sorted.map((r) => r.group_key)).toEqual(["g2", "g3", "g1"]);

    const page = await provider.query("watcher_state", {
      sortField: "updated_at",
      sortOrder: "desc",
      page: 1,
      pageSize: 2,
    });
    expect(page.map((r) => r.group_key)).toEqual(["g2", "g3"]);
  });

  test("get-by-id is unsupported for the composite-PK table (degrades, does not crash)", async () => {
    const provider = makeProvider();
    await expect(provider.get("watcher_state", "anything")).rejects.toThrow(
      /not supported for "watcher_state"/,
    );
  });

  test("create/update/delete are rejected (read-only system entity)", async () => {
    const provider = makeProvider();
    await expect(provider.create("watcher_state", {})).rejects.toThrow("Cannot create");
    await expect(provider.update("watcher_state", "x", {})).rejects.toThrow("Cannot update");
    await expect(provider.delete("watcher_state", "x")).rejects.toThrow("Cannot delete");
  });
});
