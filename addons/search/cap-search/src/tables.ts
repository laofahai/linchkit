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

export const searchDocumentsTable = linchkitSchema.table(
  "search_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: varchar("tenant_id", { length: 255 }),
    entity: varchar("entity", { length: 255 }).notNull(),
    recordId: varchar("record_id", { length: 255 }).notNull(),
    tsv: tsvector("tsv").notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    // One row per (tenant, entity, record). NULL tenant_id is treated as a
    // distinct value by Postgres, so single-tenant deployments work.
    uniqueIndex("idx_search_documents_unique").on(table.tenantId, table.entity, table.recordId),
    index("idx_search_documents_entity").on(table.entity),
    // GIN index on tsv is created via raw SQL in a follow-up migration —
    // drizzle-kit currently emits btree by default for non-standard types.
    // Phase 1 documents this as a manual migration step in the README.
  ],
);
