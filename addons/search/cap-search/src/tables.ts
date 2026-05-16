/**
 * cap-search Drizzle table definitions.
 *
 * A single shared `_linchkit.search_documents` table mirrors a row per
 * (tenant, entity, record) tuple. The `tsv` column stores the precomputed
 * tsvector and is GIN-indexed for fast `@@` lookups.
 *
 * NOTE: Drizzle does not yet ship a first-class `tsvector` type. We declare it
 * via `customType` so generated SQL emits the correct column type. The column
 * is populated server-side via `to_tsvector('simple', $content)`.
 */

import { linchkitSchema } from "@linchkit/core/server";
import { customType, index, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

// ── Custom tsvector type ────────────────────────────────────

const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return "tsvector";
  },
});

// ── search_documents table ──────────────────────────────────

/**
 * Tenant-less rows (single-tenant deployments or system entities) are stored
 * with `tenant_id = ''` rather than NULL. Postgres treats NULLs as distinct in
 * standard unique indexes, so a NULLable `tenant_id` would silently allow
 * duplicate rows per (entity, record_id). Forcing an empty-string sentinel
 * keeps the unique index meaningful without resorting to a partial index +
 * COALESCE expression. The application layer translates a missing tenantId to
 * `''` at insert time and treats `''` as "no tenant" at query time.
 */
export const NO_TENANT_SENTINEL = "";

export const searchDocumentsTable = linchkitSchema.table(
  "search_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: varchar("tenant_id", { length: 255 }).notNull().default(NO_TENANT_SENTINEL),
    entity: varchar("entity", { length: 255 }).notNull(),
    recordId: varchar("record_id", { length: 255 }).notNull(),
    tsv: tsvector("tsv").notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    // One row per (tenant, entity, record). tenant_id is NOT NULL with a `''`
    // default so the unique index actually prevents duplicates — see the
    // NO_TENANT_SENTINEL doc above for why we don't allow NULL here.
    uniqueIndex("idx_search_documents_unique").on(table.tenantId, table.entity, table.recordId),
    index("idx_search_documents_entity").on(table.entity),
    // GIN index on tsv is created via raw SQL in a follow-up migration —
    // drizzle-kit currently emits btree by default for non-standard types.
    // Phase 1 documents this as a manual migration step in the README.
  ],
);
