/**
 * DrizzleWatcherStateStore integration tests against a real PostgreSQL database.
 *
 * The unit tests in watcher-state-store.test.ts exercise the in-memory store +
 * engine wiring. This suite drives the REAL Drizzle-backed store against a real
 * `_linchkit.watcher_state` table — the production debounce-state backend — to
 * prove the restart-safety guarantee end-to-end through PostgreSQL:
 *   - set() upserts a row (ON CONFLICT on the composite PK),
 *   - load() materializes the persisted entries,
 *   - a fresh WatcherEngine hydrated from the same DB does NOT re-fire an
 *     already-fired `once_until_reset` watcher (the bug this PR fixes),
 *   - delete()/clearForWatcher() remove rows.
 *
 * Requires a running PostgreSQL instance. Set DATABASE_TEST_URL to connect.
 * Default: postgres://linchkit_test:linchkit_test@localhost:5434/linchkit_test
 * Skips gracefully when no database is available (CI without PG won't fail);
 * CI provides the `postgres` service so this suite RUNS there.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { defineWatcher } from "@linchkit/core";
import { closeDatabase, createDatabase, createWatcherRegistry } from "@linchkit/core/server";
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  createWatcherEngine,
  type WatcherActionExecutor,
  type WatcherEngine,
} from "../src/watcher-engine";
import { DrizzleWatcherStateStore } from "../src/watcher-state-store-drizzle";

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
    // Always release the probe pool so a failed probe never leaks connections.
    await closeDatabase();
  }
}

const dbAvailable = await canConnect();

if (!dbAvailable) {
  console.warn("PostgreSQL not available, skipping DrizzleWatcherStateStore integration tests");
}

// ── Fixtures ─────────────────────────────────────────────────

let db: PostgresJsDatabase | null = null;
let store: DrizzleWatcherStateStore;

/**
 * Narrow `db` to non-null. Assigned in beforeAll; the suite is skipped when no
 * DB is available, so this never throws in practice. A clear error beats the
 * repo-banned `db!` non-null assertion (biome `noNonNullAssertion`).
 */
function requireDb(): PostgresJsDatabase {
  if (!db) throw new Error("db not initialized — beforeAll did not run");
  return db;
}

function createMockActionExecutor(): WatcherActionExecutor & {
  calls: Array<{ actionName: string; input: Record<string, unknown> }>;
} {
  const calls: Array<{ actionName: string; input: Record<string, unknown> }> = [];
  return {
    calls,
    async executeAction(actionName, input) {
      calls.push({ actionName, input });
      return { ok: true };
    },
  };
}

function lowStockOnceUntilReset() {
  return defineWatcher({
    name: "low-stock-pg",
    watch: { entity: "inventory" },
    trigger: {
      type: "threshold",
      field: "quantity",
      condition: { lt: 10 },
      debounce: "once_until_reset",
    },
    effect: { action: "reorder", params: {} },
  });
}

// ── Test suite ───────────────────────────────────────────────

describe.skipIf(!dbAvailable)("DrizzleWatcherStateStore (integration)", () => {
  beforeAll(async () => {
    db = createDatabase({ url: DATABASE_URL });

    // The `_linchkit` schema already hosts framework system tables, but create
    // it defensively so the suite is self-contained.
    await db.execute(sql.raw(`CREATE SCHEMA IF NOT EXISTS "_linchkit"`));

    // Drop any leftover table, then recreate it as a test fixture. This is NOT
    // production DDL (production DDL is delegated to drizzle-kit); it mirrors the
    // column shape + composite PK declared in src/watcher-state-table.ts so the
    // real DrizzleWatcherStateStore runs against an authentic schema.
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

    store = new DrizzleWatcherStateStore(db);
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

  // ── 1. set + load round-trip ───────────────────────────────

  it("set persists a row and load materializes it", async () => {
    const firedAt = new Date("2026-02-02T03:04:05Z");
    await store.set("w1", "item-1", {
      watcherName: "w1",
      groupKey: "item-1",
      lastFiredAt: firedAt,
      conditionMet: true,
    });

    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.watcherName).toBe("w1");
    expect(loaded[0]?.groupKey).toBe("item-1");
    expect(loaded[0]?.conditionMet).toBe(true);
    expect(loaded[0]?.lastFiredAt?.getTime()).toBe(firedAt.getTime());
  });

  // ── 2. ON CONFLICT upsert on the composite PK ──────────────

  it("set upserts on the (watcher_name, group_key) primary key", async () => {
    await store.set("w1", "g", {
      watcherName: "w1",
      groupKey: "g",
      lastFiredAt: null,
      conditionMet: true,
    });
    await store.set("w1", "g", {
      watcherName: "w1",
      groupKey: "g",
      lastFiredAt: null,
      conditionMet: false,
    });

    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.conditionMet).toBe(false);

    const [{ count }] = (await requireDb().execute(
      sql.raw(`SELECT COUNT(*)::int AS count FROM ${TABLE}`),
    )) as Array<{ count: number }>;
    expect(count).toBe(1);
  });

  // ── 3. delete + clearForWatcher ────────────────────────────

  it("delete removes one entry; clearForWatcher removes a watcher's entries", async () => {
    await store.set("w1", "a", {
      watcherName: "w1",
      groupKey: "a",
      lastFiredAt: null,
      conditionMet: true,
    });
    await store.set("w1", "b", {
      watcherName: "w1",
      groupKey: "b",
      lastFiredAt: null,
      conditionMet: true,
    });
    await store.set("w2", "a", {
      watcherName: "w2",
      groupKey: "a",
      lastFiredAt: null,
      conditionMet: true,
    });

    await store.delete("w1", "a");
    expect(await store.load()).toHaveLength(2);

    await store.clearForWatcher("w1");
    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.watcherName).toBe("w2");
  });

  // ── 4. END-TO-END restart safety through PostgreSQL ────────

  it("a restarted engine hydrated from PG does not re-fire an already-fired watcher", async () => {
    const registry = createWatcherRegistry();
    registry.register(lowStockOnceUntilReset());

    // Engine A drives the watcher to its fired state; debounce state lands in PG.
    const executorA = createMockActionExecutor();
    const engineA: WatcherEngine = createWatcherEngine({
      registry,
      actionExecutor: executorA,
      stateStore: store,
    });
    const r1 = await engineA.evaluateAfterMutation("inventory", { id: "item-1", quantity: 5 });
    expect(r1[0]?.fired).toBe(true);
    expect(executorA.calls).toHaveLength(1);
    // Write-through is serialized / fire-and-forget → await it has drained to PG.
    await engineA.whenPersisted();
    engineA.stop();

    // The fired state was persisted to PG.
    expect(await store.load()).toHaveLength(1);

    // Engine B = simulated restart: fresh cache, same PG-backed store. Hydrate
    // from PG, then the same condition must be debounced (no re-fire).
    const executorB = createMockActionExecutor();
    const engineB: WatcherEngine = createWatcherEngine({
      registry,
      actionExecutor: executorB,
      stateStore: store,
    });
    await engineB.hydrate();

    const restored = engineB.getState("low-stock-pg", "item-1");
    expect(restored?.conditionMet).toBe(true);

    const r2 = await engineB.evaluateAfterMutation("inventory", { id: "item-1", quantity: 2 });
    expect(r2[0]?.fired).toBe(false);
    expect(r2[0]?.reason).toBe("debounced");
    expect(executorB.calls).toHaveLength(0);
    engineB.stop();
  });
});
