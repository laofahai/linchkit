/**
 * Integration tests for DrizzleDataProvider against a real PostgreSQL database.
 *
 * Requires a running PostgreSQL instance. Set DATABASE_TEST_URL env var to connect.
 * Default: postgres://linchkit_test:linchkit_test@localhost:5434/linchkit_test
 *
 * Skips gracefully when no database is available (CI without PG won't fail).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ConflictError, defineEntity, NotFoundError } from "@linchkit/core";
import {
  closeDatabase,
  createDatabase,
  DrizzleDataProvider,
  generateDrizzleTable,
  TableRegistry,
} from "@linchkit/core/server";
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

// ── Test configuration ───────────────────────────────────────

const DATABASE_URL =
  process.env.DATABASE_TEST_URL ??
  "postgres://linchkit_test:linchkit_test@localhost:5434/linchkit_test";

const testSchema = defineEntity({
  name: "integration_test_item",
  label: "Test Item",
  fields: {
    title: { type: "string", required: true },
    amount: { type: "number" },
    status: { type: "string" },
  },
});

const SCHEMA_NAME = testSchema.name;

// ── Connection check ─────────────────────────────────────────

let db: PostgresJsDatabase | null = null;
let tableRegistry: TableRegistry;
let provider: DrizzleDataProvider;

/**
 * Try to connect to the database.
 * Returns true if connection succeeds, false otherwise.
 */
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
  console.warn("PostgreSQL not available, skipping DrizzleDataProvider integration tests");
}

// ── Test suite ───────────────────────────────────────────────

describe.skipIf(!dbAvailable)("DrizzleDataProvider (integration)", () => {
  beforeAll(async () => {
    db = createDatabase({ url: DATABASE_URL });

    // Drop test table if it exists from a previous run
    await db.execute(sql.raw(`DROP TABLE IF EXISTS "${SCHEMA_NAME}" CASCADE`));

    // Set up table registry
    tableRegistry = new TableRegistry();
    const table = generateDrizzleTable(testSchema);
    tableRegistry.register(SCHEMA_NAME, table);

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
        "amount" numeric,
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
    // Clean up generated test schema file
    try {
      const { unlinkSync } = await import("node:fs");
      const { join } = await import("node:path");
      unlinkSync(join(process.cwd(), ".linchkit", "test-schema.generated.ts"));
    } catch {
      // Ignore if already cleaned up
    }
  });

  beforeEach(async () => {
    provider = new DrizzleDataProvider(db as NonNullable<typeof db>, tableRegistry);
  });

  afterEach(async () => {
    if (db) {
      await db.execute(sql.raw(`TRUNCATE TABLE "${SCHEMA_NAME}"`));
    }
  });

  // ── 1. create ──────────────────────────────────────────

  test("create — returns record with id, _version=1, created_at, deleted_at=null", async () => {
    const created = await provider.create(SCHEMA_NAME, {
      title: "Test Record",
      amount: 42,
    });

    expect(created.id).toBeDefined();
    expect(typeof created.id).toBe("string");
    expect(created.title).toBe("Test Record");
    expect(created._version).toBe(1);
    expect(created.created_at).toBeDefined();
    expect(created.deleted_at).toBeNull();
  });

  // ── 2. get ─────────────────────────────────────────────

  test("get — retrieves by id, matches created data", async () => {
    const created = await provider.create(SCHEMA_NAME, { title: "Fetchable" });
    const id = created.id as string;

    const fetched = await provider.get(SCHEMA_NAME, id);
    expect(fetched.id).toBe(id);
    expect(fetched.title).toBe("Fetchable");
  });

  // ── 3. get not found ──────────────────────────────────

  test("get not found — throws NotFoundError for non-existent id", async () => {
    await expect(provider.get(SCHEMA_NAME, "non-existent-id")).rejects.toThrow(NotFoundError);
  });

  // ── 4. query ──────────────────────────────────────────

  test("query — returns records matching filter", async () => {
    await provider.create(SCHEMA_NAME, { title: "Alpha", status: "active" });
    await provider.create(SCHEMA_NAME, { title: "Bravo", status: "draft" });
    await provider.create(SCHEMA_NAME, { title: "Charlie", status: "active" });

    const results = await provider.query(SCHEMA_NAME, { status: "active" });
    expect(results.length).toBe(2);
    for (const r of results) {
      expect(r.status).toBe("active");
    }
  });

  // ── 5. query with pagination ──────────────────────────

  test("query with pagination — page/pageSize work correctly", async () => {
    for (let i = 1; i <= 7; i++) {
      await provider.create(SCHEMA_NAME, {
        title: `Item ${String(i).padStart(2, "0")}`,
      });
    }

    const page1 = await provider.query(SCHEMA_NAME, { page: 1, pageSize: 3 });
    expect(page1.length).toBe(3);

    const page2 = await provider.query(SCHEMA_NAME, { page: 2, pageSize: 3 });
    expect(page2.length).toBe(3);

    const page3 = await provider.query(SCHEMA_NAME, { page: 3, pageSize: 3 });
    expect(page3.length).toBe(1); // 7 items, last page has 1

    // Pages should not overlap
    const page1Ids = new Set(page1.map((r) => r.id));
    for (const r of page2) {
      expect(page1Ids.has(r.id as string)).toBe(false);
    }
  });

  // ── 6. query with sort ────────────────────────────────

  test("query with sort — sortField/sortOrder work correctly", async () => {
    await provider.create(SCHEMA_NAME, { title: "Charlie" });
    await provider.create(SCHEMA_NAME, { title: "Alpha" });
    await provider.create(SCHEMA_NAME, { title: "Bravo" });

    const asc = await provider.query(SCHEMA_NAME, { sortField: "title", sortOrder: "asc" });
    expect(asc.map((r) => r.title)).toEqual(["Alpha", "Bravo", "Charlie"]);

    const desc = await provider.query(SCHEMA_NAME, { sortField: "title", sortOrder: "desc" });
    expect(desc.map((r) => r.title)).toEqual(["Charlie", "Bravo", "Alpha"]);
  });

  // ── 7. count ──────────────────────────────────────────

  test("count — returns correct count, strips meta keys", async () => {
    expect(await provider.count(SCHEMA_NAME)).toBe(0);

    await provider.create(SCHEMA_NAME, { title: "One" });
    await provider.create(SCHEMA_NAME, { title: "Two" });
    await provider.create(SCHEMA_NAME, { title: "Three" });

    expect(await provider.count(SCHEMA_NAME)).toBe(3);

    // Meta keys in filter should be stripped (not treated as column filters)
    expect(await provider.count(SCHEMA_NAME, { page: 1, pageSize: 2, sortField: "title" })).toBe(3);
  });

  // ── 8. update ─────────────────────────────────────────

  test("update — updates fields, increments _version", async () => {
    const created = await provider.create(SCHEMA_NAME, { title: "Original" });
    const id = created.id as string;
    expect(created._version).toBe(1);

    const updated = await provider.update(SCHEMA_NAME, id, {
      title: "Updated",
      _version: 1,
    });
    expect(updated.title).toBe("Updated");
    expect(updated._version).toBe(2);
  });

  // ── 9. update optimistic locking ──────────────────────

  test("update optimistic locking — conflicting version throws ConflictError", async () => {
    const created = await provider.create(SCHEMA_NAME, { title: "Conflict Test" });
    const id = created.id as string;

    // First update: version 1 → 2
    await provider.update(SCHEMA_NAME, id, { title: "v2", _version: 1 });

    // Second update with stale version 1 → should throw ConflictError
    await expect(provider.update(SCHEMA_NAME, id, { title: "stale", _version: 1 })).rejects.toThrow(
      ConflictError,
    );
  });

  // ── 10. delete (soft) ─────────────────────────────────

  test("delete (soft) — sets deleted_at, record hidden from get/query", async () => {
    const created = await provider.create(SCHEMA_NAME, { title: "To Delete" });
    const id = created.id as string;

    await provider.delete(SCHEMA_NAME, id);

    // Regular get should fail
    await expect(provider.get(SCHEMA_NAME, id)).rejects.toThrow(NotFoundError);

    // Regular query should not include it
    const results = await provider.query(SCHEMA_NAME, {});
    expect(results.length).toBe(0);
  });

  // ── 11. delete already deleted ────────────────────────

  test("delete already deleted — throws NotFoundError", async () => {
    const created = await provider.create(SCHEMA_NAME, { title: "Double Delete" });
    const id = created.id as string;

    await provider.delete(SCHEMA_NAME, id);

    // Second delete should throw NotFoundError (already soft-deleted)
    await expect(provider.delete(SCHEMA_NAME, id)).rejects.toThrow(NotFoundError);
  });

  // ── 12. get with includeDeleted ───────────────────────

  test("get with includeDeleted — finds soft-deleted record", async () => {
    const created = await provider.create(SCHEMA_NAME, { title: "Recoverable" });
    const id = created.id as string;

    await provider.delete(SCHEMA_NAME, id);

    const found = await provider.get(SCHEMA_NAME, id, { includeDeleted: true });
    expect(found.id).toBe(id);
    expect(found.title).toBe("Recoverable");
    expect(found.deleted_at).not.toBeNull();
  });

  // ── 13. hardDelete ────────────────────────────────────

  test("hardDelete — physically removes record", async () => {
    const created = await provider.create(SCHEMA_NAME, { title: "Permanent Delete" });
    const id = created.id as string;

    await provider.hardDelete(SCHEMA_NAME, id);

    // Should not be found even with includeDeleted
    await expect(provider.get(SCHEMA_NAME, id, { includeDeleted: true })).rejects.toThrow(
      NotFoundError,
    );
  });

  // ── 14. tenant isolation — get ────────────────────────

  test("tenant isolation — get — tenantId mismatch returns NotFound", async () => {
    const created = await provider.create(SCHEMA_NAME, {
      title: "Tenant A Only",
      tenant_id: "tenant-a",
    });
    const id = created.id as string;

    // Same tenant can access
    const fetched = await provider.get(SCHEMA_NAME, id, { tenantId: "tenant-a" });
    expect(fetched.title).toBe("Tenant A Only");

    // Different tenant cannot access
    await expect(provider.get(SCHEMA_NAME, id, { tenantId: "tenant-b" })).rejects.toThrow(
      NotFoundError,
    );
  });

  // ── 15. tenant isolation — query ──────────────────────

  test("tenant isolation — query — only returns matching tenant's records", async () => {
    await provider.create(SCHEMA_NAME, { title: "A1", tenant_id: "tenant-a" });
    await provider.create(SCHEMA_NAME, { title: "A2", tenant_id: "tenant-a" });
    await provider.create(SCHEMA_NAME, { title: "B1", tenant_id: "tenant-b" });

    const tenantA = await provider.query(SCHEMA_NAME, {}, { tenantId: "tenant-a" });
    expect(tenantA.length).toBe(2);
    for (const r of tenantA) {
      expect(r.tenant_id).toBe("tenant-a");
    }

    const tenantB = await provider.query(SCHEMA_NAME, {}, { tenantId: "tenant-b" });
    expect(tenantB.length).toBe(1);
    expect(tenantB[0].tenant_id).toBe("tenant-b");

    // Without tenant filter, returns all
    const all = await provider.query(SCHEMA_NAME, {});
    expect(all.length).toBe(3);
  });

  // ── 16. tenant isolation — count ──────────────────────

  test("tenant isolation — count — only counts matching tenant's records", async () => {
    await provider.create(SCHEMA_NAME, { title: "A1", tenant_id: "t1" });
    await provider.create(SCHEMA_NAME, { title: "A2", tenant_id: "t1" });
    await provider.create(SCHEMA_NAME, { title: "B1", tenant_id: "t2" });

    expect(await provider.count(SCHEMA_NAME, {}, { tenantId: "t1" })).toBe(2);
    expect(await provider.count(SCHEMA_NAME, {}, { tenantId: "t2" })).toBe(1);
    expect(await provider.count(SCHEMA_NAME)).toBe(3);
  });

  // ── 17. full CRUD lifecycle ─────────────────────────

  test("full CRUD lifecycle — create → get → update → delete → verify soft deleted → hardDelete", async () => {
    // Create
    const created = await provider.create(SCHEMA_NAME, { title: "Lifecycle", amount: 100 });
    const id = created.id as string;
    expect(created._version).toBe(1);

    // Get
    const fetched = await provider.get(SCHEMA_NAME, id);
    expect(fetched.title).toBe("Lifecycle");
    // PG doublePrecision returns string via postgres-js driver
    expect(Number(fetched.amount)).toBe(100);

    // Update
    const updated = await provider.update(SCHEMA_NAME, id, {
      title: "Updated Lifecycle",
      _version: 1,
    });
    expect(updated.title).toBe("Updated Lifecycle");
    expect(updated._version).toBe(2);

    // Soft delete
    await provider.delete(SCHEMA_NAME, id);

    // Verify soft deleted — hidden from normal get
    await expect(provider.get(SCHEMA_NAME, id)).rejects.toThrow(NotFoundError);

    // Verify still accessible with includeDeleted
    const softDeleted = await provider.get(SCHEMA_NAME, id, { includeDeleted: true });
    expect(softDeleted.deleted_at).not.toBeNull();

    // Hard delete
    await provider.hardDelete(SCHEMA_NAME, id);

    // Verify completely gone
    await expect(provider.get(SCHEMA_NAME, id, { includeDeleted: true })).rejects.toThrow(
      NotFoundError,
    );
  });

  // ── 18. version auto-increment through multiple updates ──

  test("version auto-increment — create(v1) → update(v2) → update(v3)", async () => {
    const created = await provider.create(SCHEMA_NAME, { title: "Version Track" });
    const id = created.id as string;
    expect(created._version).toBe(1);

    const v2 = await provider.update(SCHEMA_NAME, id, { title: "v2", _version: 1 });
    expect(v2._version).toBe(2);

    const v3 = await provider.update(SCHEMA_NAME, id, { title: "v3", _version: 2 });
    expect(v3._version).toBe(3);

    // Verify final state
    const final = await provider.get(SCHEMA_NAME, id);
    expect(final.title).toBe("v3");
    expect(final._version).toBe(3);
  });

  // ── 19. update non-existent ID ────────────────────────

  test("update non-existent ID — throws NotFoundError", async () => {
    await expect(
      provider.update(SCHEMA_NAME, "non-existent-id", { title: "Ghost" }),
    ).rejects.toThrow(NotFoundError);
  });

  // ── 20. delete non-existent ID ────────────────────────

  test("delete non-existent ID — throws NotFoundError", async () => {
    await expect(provider.delete(SCHEMA_NAME, "non-existent-id")).rejects.toThrow(NotFoundError);
  });

  // ── 21. hardDelete non-existent ID ────────────────────

  test("hardDelete non-existent ID — throws NotFoundError", async () => {
    await expect(provider.hardDelete(SCHEMA_NAME, "non-existent-id")).rejects.toThrow(
      NotFoundError,
    );
  });

  // ── 22. count excludes soft-deleted records ───────────

  test("count — excludes soft-deleted records by default", async () => {
    await provider.create(SCHEMA_NAME, { title: "Alive" });
    const toDelete = await provider.create(SCHEMA_NAME, { title: "Will Die" });

    expect(await provider.count(SCHEMA_NAME)).toBe(2);

    await provider.delete(SCHEMA_NAME, toDelete.id as string);

    expect(await provider.count(SCHEMA_NAME)).toBe(1);
    expect(await provider.count(SCHEMA_NAME, {}, { includeDeleted: true })).toBe(2);
  });

  // ── 23. query with includeDeleted ─────────────────────

  test("query with includeDeleted — returns soft-deleted records", async () => {
    await provider.create(SCHEMA_NAME, { title: "Visible" });
    const toDelete = await provider.create(SCHEMA_NAME, { title: "Hidden" });

    await provider.delete(SCHEMA_NAME, toDelete.id as string);

    const normal = await provider.query(SCHEMA_NAME, {});
    expect(normal.length).toBe(1);

    const withDeleted = await provider.query(SCHEMA_NAME, {}, { includeDeleted: true });
    expect(withDeleted.length).toBe(2);
  });

  // ── 24. tenant isolation — delete respects tenant ─────

  test("tenant isolation — delete — cannot delete another tenant's record", async () => {
    const created = await provider.create(SCHEMA_NAME, {
      title: "Tenant A Record",
      tenant_id: "tenant-a",
    });
    const id = created.id as string;

    // Trying to delete with wrong tenant should fail
    await expect(provider.delete(SCHEMA_NAME, id, { tenantId: "tenant-b" })).rejects.toThrow(
      NotFoundError,
    );

    // Record should still exist
    const fetched = await provider.get(SCHEMA_NAME, id, { tenantId: "tenant-a" });
    expect(fetched.title).toBe("Tenant A Record");
  });

  // ── 25. tenant isolation — update respects tenant ─────

  test("tenant isolation — update — cannot update another tenant's record", async () => {
    const created = await provider.create(SCHEMA_NAME, {
      title: "Immutable by Others",
      tenant_id: "tenant-x",
    });
    const id = created.id as string;

    // Wrong tenant update should throw NotFoundError
    await expect(
      provider.update(SCHEMA_NAME, id, { title: "Hacked" }, { tenantId: "tenant-y" }),
    ).rejects.toThrow(NotFoundError);

    // Original should be unchanged
    const fetched = await provider.get(SCHEMA_NAME, id, { tenantId: "tenant-x" });
    expect(fetched.title).toBe("Immutable by Others");
  });

  // ── 26. tenant isolation — version conflict does not leak existence ──

  test("tenant isolation — update with version conflict does not leak existence", async () => {
    // Create record as tenant-a
    const record = await provider.create(SCHEMA_NAME, {
      title: "Tenant A Record",
      tenant_id: "tenant-a",
    });

    // Tenant B tries to update with correct version — should get NotFound, not Conflict
    // This verifies that cross-tenant updates fail with NotFoundError (record doesn't
    // exist from tenant B's perspective) rather than ConflictError (which would leak
    // the fact that the record exists in another tenant).
    await expect(
      provider.update(
        SCHEMA_NAME,
        record.id as string,
        { title: "Hacked", _version: record._version },
        { tenantId: "tenant-b" },
      ),
    ).rejects.toThrow(NotFoundError);
  });
});
