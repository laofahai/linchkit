/**
 * Integration tests for DrizzleDataProvider row-level locking (`forUpdate`, #470).
 *
 * Split out of drizzle-data-provider.integration.test.ts to keep both files under
 * the 500-line limit. Requires a running PostgreSQL instance — set
 * DATABASE_TEST_URL (default postgres://linchkit_test:linchkit_test@localhost:5434/linchkit_test).
 * Skips gracefully when no database is available (CI without PG won't fail).
 *
 * Uses a `FOR UPDATE NOWAIT` probe from a SEPARATE pooled connection, so the lock
 * state is asserted deterministically with no sleeps: NOWAIT fails immediately
 * (SQLSTATE 55P03) when the row is already locked, and succeeds when it is free.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { defineEntity } from "@linchkit/core";
import {
  closeDatabase,
  createDatabase,
  DrizzleDataProvider,
  generateDrizzleTable,
  TableRegistry,
} from "@linchkit/core/server";
import { eq, getTableColumns, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

const DATABASE_URL =
  process.env.DATABASE_TEST_URL ??
  "postgres://linchkit_test:linchkit_test@localhost:5434/linchkit_test";

// Distinct table name from the sibling integration suite so the two files never
// clobber each other's fixture table if they ever run against the same database.
const testSchema = defineEntity({
  name: "row_lock_test_item",
  label: "Row Lock Test Item",
  fields: {
    title: { type: "string", required: true },
    status: { type: "string" },
  },
});

const SCHEMA_NAME = testSchema.name;

let db: PostgresJsDatabase | null = null;
let tableRegistry: TableRegistry;
let provider: DrizzleDataProvider;

async function canConnect(): Promise<boolean> {
  try {
    const testDb = createDatabase({ url: DATABASE_URL });
    await testDb.execute(sql`SELECT 1`);
    await closeDatabase();
    return true;
  } catch {
    return false;
  }
}

const dbAvailable = await canConnect();

if (!dbAvailable) {
  console.warn("PostgreSQL not available, skipping DrizzleDataProvider row-lock tests");
}

describe.skipIf(!dbAvailable)("DrizzleDataProvider row-level locking (#470)", () => {
  beforeAll(async () => {
    db = createDatabase({ url: DATABASE_URL });
    await db.execute(sql.raw(`DROP TABLE IF EXISTS "${SCHEMA_NAME}" CASCADE`));

    tableRegistry = new TableRegistry();
    tableRegistry.register(SCHEMA_NAME, generateDrizzleTable(testSchema));

    // Create test table via raw SQL (test fixture — not production DDL)
    await db.execute(
      sql.raw(`
      CREATE TABLE IF NOT EXISTS "${SCHEMA_NAME}" (
        "id" varchar(128) PRIMARY KEY NOT NULL,
        "tenant_id" varchar(128),
        "created_at" timestamp DEFAULT now() NOT NULL,
        "updated_at" timestamp DEFAULT now() NOT NULL,
        "created_by" varchar(128),
        "updated_by" varchar(128),
        "_version" integer DEFAULT 1 NOT NULL,
        "deleted_at" timestamp,
        "_extensions" jsonb,
        "title" varchar(255) NOT NULL,
        "status" varchar(50)
      )
    `),
    );
  });

  afterAll(async () => {
    if (db) {
      await db.execute(sql.raw(`DROP TABLE IF EXISTS "${SCHEMA_NAME}" CASCADE`));
      await closeDatabase();
    }
  });

  beforeEach(() => {
    provider = new DrizzleDataProvider(db as NonNullable<typeof db>, tableRegistry);
  });

  afterEach(async () => {
    if (db) {
      await db.execute(sql.raw(`TRUNCATE TABLE "${SCHEMA_NAME}"`));
    }
  });

  /**
   * Probe whether `id`'s row is lockable from a SEPARATE pooled connection.
   * `FOR UPDATE NOWAIT` fails immediately (SQLSTATE 55P03) when the row is
   * already locked, so this is a deterministic test of lock state with no sleeps.
   */
  const probeRowLockable = async (id: string): Promise<boolean> => {
    const table = tableRegistry.getTable(SCHEMA_NAME);
    const idCol = getTableColumns(table).id;
    try {
      await (db as NonNullable<typeof db>)
        .select()
        .from(table)
        .where(eq(idCol, id))
        .for("update", { noWait: true });
      return true; // acquired the lock → the row was free
    } catch {
      return false; // 55P03 lock_not_available → the row is locked elsewhere
    }
  };

  test("get with forUpdate — pins the row with a lock that blocks a concurrent writer", async () => {
    const created = await provider.create(SCHEMA_NAME, { title: "Lockable", status: "pending" });
    const id = created.id as string;

    await (db as NonNullable<typeof db>).transaction(async (tx) => {
      const txProvider = provider.withConnection(tx as unknown as PostgresJsDatabase);
      const locked = await txProvider.get(SCHEMA_NAME, id, { forUpdate: true });
      expect(locked.id).toBe(id);
      // While the transaction holds the FOR UPDATE lock, a separate session can't lock it.
      expect(await probeRowLockable(id)).toBe(false);
    });

    // The lock is released once the transaction commits.
    expect(await probeRowLockable(id)).toBe(true);
  });

  test("get without forUpdate — takes no row lock (opt-in)", async () => {
    const created = await provider.create(SCHEMA_NAME, { title: "Unlocked", status: "pending" });
    const id = created.id as string;

    await (db as NonNullable<typeof db>).transaction(async (tx) => {
      const txProvider = provider.withConnection(tx as unknown as PostgresJsDatabase);
      await txProvider.get(SCHEMA_NAME, id); // plain read — no lock requested
      // A plain read leaves the row free, so another session can still lock it.
      expect(await probeRowLockable(id)).toBe(true);
    });
  });
});
