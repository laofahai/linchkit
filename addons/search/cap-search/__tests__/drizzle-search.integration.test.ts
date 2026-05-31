/**
 * DrizzleSearchService integration tests against a real PostgreSQL database.
 *
 * The unit tests in service.test.ts / event-handler.test.ts / graphql.test.ts
 * all exercise the InMemorySearchService — the explicitly "dev/test only"
 * substring matcher. The PRODUCTION backend (DrizzleSearchService:
 * `to_tsvector('simple', …)` + `plainto_tsquery` + `ts_rank`, ON CONFLICT
 * upsert, SQL-level tenant scoping) had no coverage at all. This suite closes
 * that gap by driving the REAL index→query round-trip end-to-end:
 *   - the real `createSearchIndexer` event handler →
 *   - the real DrizzleSearchService →
 *   - a real `_linchkit.search_documents` table with a real tsvector + GIN index;
 *   - and the real GraphQL `search` resolver reading back through Drizzle.
 *
 * Requires a running PostgreSQL instance. Set DATABASE_TEST_URL to connect.
 * Default: postgres://linchkit_test:linchkit_test@localhost:5434/linchkit_test
 * Skips gracefully when no database is available (CI without PG won't fail);
 * CI provides the `postgres` service so this suite RUNS there.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { EventRecord } from "@linchkit/core";
import { closeDatabase, createDatabase } from "@linchkit/core/server";
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { GraphQLNonNull, GraphQLObjectType, GraphQLSchema, GraphQLString, graphql } from "graphql";
import { defineSearchIndex } from "../src/define-search-index";
import { buildSearchIndexRegistry, createSearchIndexer } from "../src/event-handler";
import { buildSearchGraphQLExtension } from "../src/graphql";
import { DrizzleSearchService } from "../src/service";
import { NO_TENANT_SENTINEL } from "../src/tables";

// ── Test configuration ───────────────────────────────────────

const DATABASE_URL =
  process.env.DATABASE_TEST_URL ??
  "postgres://linchkit_test:linchkit_test@localhost:5434/linchkit_test";

const TABLE = `"_linchkit"."search_documents"`;

const ENTITY = "purchase_request";

const registry = buildSearchIndexRegistry([
  defineSearchIndex({ entity: ENTITY, fields: ["title", "description", "vendor"] }),
]);

// ── Connection check ─────────────────────────────────────────

async function canConnect(): Promise<boolean> {
  try {
    const testDb = createDatabase({ url: DATABASE_URL });
    await testDb.execute(sql`SELECT 1`);
    return true;
  } catch {
    return false;
  } finally {
    // Always release the probe pool, even if execute() throws, so a failed
    // probe never leaks connections into the rest of the suite.
    await closeDatabase();
  }
}

const dbAvailable = await canConnect();

if (!dbAvailable) {
  console.warn("PostgreSQL not available, skipping DrizzleSearchService integration tests");
}

// ── Fixtures ─────────────────────────────────────────────────

let db: PostgresJsDatabase | null = null;
let service: DrizzleSearchService;

/**
 * Narrow `db` to non-null. It is assigned in beforeAll and the suite is
 * skipped when no DB is available, so this never throws in practice — but a
 * clear error beats an unsafe `db?` destructure (which yields a cryptic
 * "undefined is not iterable") or a `db!` non-null assertion (which the
 * repo's biome config bans as `noNonNullAssertion`).
 */
function requireDb(): PostgresJsDatabase {
  if (!db) throw new Error("db not initialized — beforeAll did not run");
  return db;
}

/** Build a record.created/updated/deleted event mirroring the real CRUD emitter shape. */
function makeEvent(type: string, overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: "evt-001",
    type,
    category: "change",
    timestamp: new Date(),
    actor: { type: "user", id: "user-001" },
    executionId: "exec-001",
    payload: {},
    entity: ENTITY,
    recordId: "rec-001",
    ...overrides,
  };
}

/** Minimal stub event-handler context — the indexer only awaits the service. */
const stubCtx = {
  emit: () => {},
  meta: { get: () => undefined, toJSON: () => ({}) },
} as never;

/** Build a real GraphQL schema wired to the Drizzle-backed search service. */
function buildSearchSchema(svc: DrizzleSearchService): GraphQLSchema {
  const ext = buildSearchGraphQLExtension({ service: svc });
  return new GraphQLSchema({
    query: new GraphQLObjectType({
      name: "Query",
      fields: {
        ping: { type: new GraphQLNonNull(GraphQLString), resolve: () => "pong" },
        ...ext.queryFields,
      },
    }),
  });
}

// ── Test suite ───────────────────────────────────────────────

describe.skipIf(!dbAvailable)("DrizzleSearchService (integration)", () => {
  beforeAll(async () => {
    db = createDatabase({ url: DATABASE_URL });

    // The `_linchkit` schema already hosts the framework system tables, but
    // create it defensively so the suite is self-contained.
    await db.execute(sql.raw(`CREATE SCHEMA IF NOT EXISTS "_linchkit"`));

    // Drop any leftover table from a previous run, then recreate it as a test
    // fixture. This is NOT production DDL — production DDL is delegated to
    // drizzle-kit; this mirrors the column shape declared in src/tables.ts plus
    // the manual GIN index documented in the cap-search README, so the real
    // DrizzleSearchService runs against an authentic schema.
    await db.execute(sql.raw(`DROP TABLE IF EXISTS ${TABLE} CASCADE`));
    await db.execute(
      sql.raw(`
      CREATE TABLE ${TABLE} (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "tenant_id" varchar(255) DEFAULT '' NOT NULL,
        "entity" varchar(255) NOT NULL,
        "record_id" varchar(255) NOT NULL,
        "tsv" tsvector NOT NULL,
        "updated_at" timestamp DEFAULT now() NOT NULL
      )
    `),
    );
    await db.execute(
      sql.raw(`
      CREATE UNIQUE INDEX "idx_search_documents_unique"
        ON ${TABLE} ("tenant_id", "entity", "record_id")
    `),
    );
    await db.execute(
      sql.raw(`CREATE INDEX "idx_search_documents_tsv" ON ${TABLE} USING GIN ("tsv")`),
    );

    service = new DrizzleSearchService(db);
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

  // ── 1. Real round-trip: index a document, find it by a matching query ──

  it("indexes a document and finds it via plainto_tsquery", async () => {
    await service.upsertDocument({
      entity: ENTITY,
      recordId: "rec-1",
      content: "Ergonomic office chair for the design team",
    });

    const hits = await service.search("chair");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.entity).toBe(ENTITY);
    expect(hits[0]?.recordId).toBe("rec-1");
    // ts_rank produces a positive score for a real match.
    expect(hits[0]?.score).toBeGreaterThan(0);
  });

  // ── 2. Non-matching query returns nothing ──────────────────

  it("returns no hits for a non-matching query", async () => {
    await service.upsertDocument({
      entity: ENTITY,
      recordId: "rec-1",
      content: "Ergonomic office chair",
    });

    expect(await service.search("spaceship")).toHaveLength(0);
    // Blank query short-circuits before hitting the DB.
    expect(await service.search("   ")).toHaveLength(0);
  });

  // ── 3. ON CONFLICT upsert replaces the prior document ──────

  it("upsert replaces the prior document for the same (tenant, entity, record)", async () => {
    await service.upsertDocument({ entity: ENTITY, recordId: "v1", content: "Acme Industries" });
    await service.upsertDocument({ entity: ENTITY, recordId: "v1", content: "GlobalCo Trading" });

    expect(await service.search("Acme")).toHaveLength(0);
    const hits = await service.search("GlobalCo");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.recordId).toBe("v1");

    // Exactly one row survives — the unique index + ON CONFLICT held.
    const [{ count }] = (await requireDb().execute(
      sql.raw(`SELECT COUNT(*)::int AS count FROM ${TABLE}`),
    )) as Array<{ count: number }>;
    expect(count).toBe(1);
  });

  // ── 4. ts_rank ordering: more matches rank higher ──────────

  it("orders hits by ts_rank (more term occurrences score higher)", async () => {
    await service.upsertDocument({
      entity: ENTITY,
      recordId: "weak",
      content: "office chair and one desk",
    });
    await service.upsertDocument({
      entity: ENTITY,
      recordId: "strong",
      content: "desk desk desk standing desk for the office",
    });

    const hits = await service.search("desk");
    expect(hits.map((h) => h.recordId)).toEqual(["strong", "weak"]);
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 0);
  });

  // ── 5. SQL-level tenant scoping ────────────────────────────

  it("scopes results by tenantId at the SQL level", async () => {
    await service.upsertDocument({
      tenantId: "t1",
      entity: ENTITY,
      recordId: "a",
      content: "shared keyword",
    });
    await service.upsertDocument({
      tenantId: "t2",
      entity: ENTITY,
      recordId: "b",
      content: "shared keyword",
    });

    const t1 = await service.search("shared", { tenantId: "t1" });
    expect(t1).toHaveLength(1);
    expect(t1[0]?.recordId).toBe("a");

    // No tenant filter matches only the unscoped (NO_TENANT_SENTINEL) bucket,
    // which has zero docs here — no cross-tenant leakage.
    expect(await service.search("shared")).toHaveLength(0);
  });

  // ── 6. entity filter ───────────────────────────────────────

  it("filters by entity when provided", async () => {
    await service.upsertDocument({ entity: "vendor", recordId: "v1", content: "office" });
    await service.upsertDocument({ entity: ENTITY, recordId: "p1", content: "office" });

    const onlyVendor = await service.search("office", { entity: "vendor" });
    expect(onlyVendor).toHaveLength(1);
    expect(onlyVendor[0]?.entity).toBe("vendor");
  });

  // ── 7. delete is reflected ─────────────────────────────────

  it("delete removes the document from query results", async () => {
    await service.upsertDocument({ entity: ENTITY, recordId: "r1", content: "deletable content" });
    expect(await service.search("deletable")).toHaveLength(1);

    await service.deleteDocument({ entity: ENTITY, recordId: "r1" });
    expect(await service.search("deletable")).toHaveLength(0);
  });

  // ── 8. NO_TENANT_SENTINEL normalization persists as '' ─────

  it("stores a missing tenantId as the empty-string sentinel", async () => {
    await service.upsertDocument({ entity: ENTITY, recordId: "r1", content: "sentinel check" });

    const rows = (await requireDb().execute(
      sql.raw(`SELECT tenant_id FROM ${TABLE} WHERE record_id = 'r1'`),
    )) as Array<{ tenant_id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenant_id).toBe(NO_TENANT_SENTINEL);
  });

  // ── 9. END-TO-END: real event-driven index → real GraphQL query ──

  it("indexes via the real event handler and finds it via the real GraphQL resolver", async () => {
    const handler = createSearchIndexer({ indexes: registry, service }).handler;

    // Drive the REAL indexer with a real-shape record.created event (entity in
    // `payload.schema`, record fields spread at the top level — exactly what
    // build-crud-actions.ts emits).
    await handler(
      makeEvent("record.created", {
        entity: undefined,
        tenantId: "tenant-A",
        payload: {
          schema: ENTITY,
          recordId: "rec-001",
          title: "Office chairs",
          description: "Need 12 ergonomic chairs",
          vendor: "Acme",
          id: "rec-001",
        },
      }),
      stubCtx,
    );

    // Query back through the real GraphQL resolver, tenant-scoped via context.
    const schema = buildSearchSchema(service);
    const result = await graphql({
      schema,
      source: `{ search(q: "ergonomic") { entity recordId score } }`,
      contextValue: { tenantId: "tenant-A" },
    });

    expect(result.errors).toBeUndefined();
    const hits = result.data?.search as Array<{
      entity: string;
      recordId: string;
      score: number;
    }>;
    expect(hits).toHaveLength(1);
    expect(hits[0]?.entity).toBe(ENTITY);
    expect(hits[0]?.recordId).toBe("rec-001");
    expect(hits[0]?.score).toBeGreaterThan(0);

    // Wrong tenant context sees nothing.
    const wrongTenant = await graphql({
      schema,
      source: `{ search(q: "ergonomic") { recordId } }`,
      contextValue: { tenantId: "tenant-B" },
    });
    expect(wrongTenant.errors).toBeUndefined();
    expect(wrongTenant.data?.search).toEqual([]);

    // ── …then a real record.deleted event removes it end-to-end ──
    await handler(
      makeEvent("record.deleted", {
        entity: undefined,
        recordId: undefined,
        tenantId: "tenant-A",
        payload: { schema: ENTITY, recordId: "rec-001", id: "rec-001" },
      }),
      stubCtx,
    );

    const afterDelete = await graphql({
      schema,
      source: `{ search(q: "ergonomic") { recordId } }`,
      contextValue: { tenantId: "tenant-A" },
    });
    expect(afterDelete.errors).toBeUndefined();
    expect(afterDelete.data?.search).toEqual([]);
  });
});
