/**
 * cap-vector-pgvector Drizzle table definitions.
 *
 * A single `_linchkit.vectors` table stores every embedding (Meta-Model
 * definitions, business-data rows, RAG chunks, …) keyed by namespace.
 *
 * NOTES
 * -----
 *  - The `embedding` column is declared via `customType` because Drizzle
 *    does not yet ship a first-class `vector(N)` type for the pgvector
 *    extension. The custom type emits `vector($dimension)` DDL so
 *    drizzle-kit generate produces the right column.
 *  - drizzle-kit cannot generate the HNSW operator-class index on its own
 *    (it would default to btree). Spec 68 §2.2 documents that the HNSW
 *    + cosine_ops index is created via a follow-up SQL step in the
 *    capability's migration — same pattern as cap-search's GIN index.
 *  - The CREATE EXTENSION statement also lives in the follow-up SQL
 *    (Drizzle is intentionally out of the extension business).
 *  - Schema DDL is never hand-written; once the host adds this capability
 *    to `linchkit.config.ts` and runs `linch db generate`, drizzle-kit
 *    emits the base CREATE TABLE. The capability ships the HNSW + pgvector
 *    bootstrap SQL as a follow-up migration in
 *    `addons/vector/cap-vector-pgvector/src/migrations/`.
 */

import { linchkitSchema } from "@linchkit/core/server";
import {
  customType,
  index,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * Default embedding dimension. Matches OpenAI `text-embedding-3-small`
 * which is the most common cheap embedding model today. Hosts can stand
 * up a second table at a different dimension if they swap providers.
 */
export const DEFAULT_VECTOR_DIMENSION = 1536;

/** Default namespace bucket used when callers omit one. */
export const DEFAULT_NAMESPACE = "default";

/**
 * Custom Drizzle column type wrapping pgvector's `vector(N)` type.
 *
 * - `data` is the in-process JS representation (number[]).
 * - `driverData` is the wire representation accepted by pg's text
 *   protocol (`'[1.0,2.0,3.0]'`).
 *
 * `toDriver` / `fromDriver` keep the conversion isolated from query
 * sites so the rest of the code can pass plain number[] around.
 */
export const vectorColumn = customType<{
  data: number[];
  driverData: string;
  config: { dimension: number };
}>({
  dataType(config) {
    const dim = config?.dimension ?? DEFAULT_VECTOR_DIMENSION;
    return `vector(${dim})`;
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    // pgvector returns text like `[1,2,3]` — strip the brackets and parse.
    // Use `Number.parseFloat` and reject non-finite components so a malformed
    // driver response never silently produces a NaN-laden vector that would
    // corrupt downstream similarity math.
    if (typeof value !== "string") return [];
    const trimmed = value.replace(/^\[|\]$/g, "").trim();
    if (trimmed.length === 0) return [];
    const parts = trimmed.split(",");
    const out = new Array<number>(parts.length);
    for (let i = 0; i < parts.length; i++) {
      const raw = parts[i] ?? "";
      const n = Number.parseFloat(raw);
      if (!Number.isFinite(n)) {
        throw new Error(
          `vectorColumn.fromDriver: invalid numeric component "${raw}" at index ${i} (value="${value}")`,
        );
      }
      out[i] = n;
    }
    return out;
  },
});

/**
 * The single shared vectors table.
 *
 * The `(id, namespace)` composite key lets the same caller-supplied id
 * appear in different namespaces without collision — e.g. an Entity
 * named `purchase_request` can have one row in `meta_model` (the
 * definition embedding) and one row per record in
 * `data:purchase_request` (business data embeddings).
 */
export const vectorsTable = linchkitSchema.table(
  "vectors",
  {
    id: varchar("id", { length: 255 }).notNull(),
    namespace: varchar("namespace", { length: 255 }).notNull().default(DEFAULT_NAMESPACE),
    embedding: vectorColumn("embedding", { dimension: DEFAULT_VECTOR_DIMENSION }).notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    content: text("content"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    // (id, namespace) is the upsert conflict target — it MUST be a unique
    // index so PostgreSQL can use it as the arbiter for
    // `INSERT ... ON CONFLICT (id, namespace) DO UPDATE`. A plain composite
    // index would cause the upsert to fail with
    // `no unique or exclusion constraint matching the ON CONFLICT specification`.
    uniqueIndex("ux_vectors_id_namespace").on(table.id, table.namespace),
    index("idx_vectors_namespace").on(table.namespace),
    // HNSW operator-class index for cosine similarity is created via
    // raw SQL in the follow-up migration; drizzle-kit cannot express it.
  ],
);
