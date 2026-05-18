/**
 * PgVectorStore — Drizzle-backed implementation of VectorStore.
 *
 * Talks to PostgreSQL with the `vector` extension enabled. Per Spec 68 §2.2,
 * the HNSW index over `vector_cosine_ops` is created by the capability's
 * migration (drizzle-kit cannot emit the operator class), so all this code
 * has to do is:
 *
 *  1. Upsert rows via `INSERT ... ON CONFLICT (id, namespace) DO UPDATE`.
 *  2. Query similarity with `ORDER BY embedding <=> $1` and convert the
 *     pgvector cosine *distance* to a `[0, 1]` score so consumers see the
 *     same range as `InMemoryVectorStore` — see `SCORE_RANGE` below.
 *  3. Apply optional JSONB containment filters and a minScore threshold.
 *
 * The constructor takes a pre-built Drizzle DB instance — the capability is
 * deliberately decoupled from how the host obtains its DB handle.
 *
 * SAFETY
 * ------
 *  - All user-supplied filter values flow through Drizzle's parameter
 *    binding via the `sql` template tag → no SQL injection.
 *  - The query vector is bound as a parameter (cast to `::vector` in SQL),
 *    not concatenated, so a hostile `id` or filter cannot smuggle SQL.
 *  - `assertDimension()` rejects vectors that contain `NaN` / `±Infinity`
 *    before they reach the wire, so a malformed embedding cannot produce
 *    a malformed SQL literal nor corrupt the index.
 */

import { and, eq, sql } from "drizzle-orm";
import { DEFAULT_NAMESPACE, DEFAULT_VECTOR_DIMENSION, vectorsTable } from "./schema";
import type {
  SimilarityResult,
  UpsertVectorInput,
  VectorSearchOptions,
  VectorStore,
} from "./types";

const DEFAULT_TOP_K = 10;
const MAX_TOP_K = 200;
/**
 * Maximum number of rows per multi-row INSERT.
 *
 * PostgreSQL's wire protocol caps bind parameters at 65535. Each vector row
 * binds ~6 parameters (id, namespace, embedding, metadata, content, plus
 * `excluded.*` references in the conflict-update clause). 500 rows × ~6
 * = ~3000 parameters leaves ample headroom while still amortising the
 * network round-trip cost.
 */
const DEFAULT_BATCH_CHUNK_SIZE = 500;

/**
 * Minimal duck-typed surface this capability invokes on the Drizzle DB
 * instance. Splitting it out keeps the `db: unknown` field type-safe at
 * call sites without coupling the capability to any particular driver
 * flavour (PgDatabase, PgliteDatabase, NodePgDatabase …).
 */
interface DrizzleDbLike {
  insert: (...args: unknown[]) => DrizzleInsertChain;
  select: (...args: unknown[]) => DrizzleSelectChain;
  delete: (...args: unknown[]) => DrizzleDeleteChain;
}

interface DrizzleInsertChain {
  values: (...args: unknown[]) => DrizzleInsertChain;
  onConflictDoUpdate: (...args: unknown[]) => Promise<unknown>;
}

interface DrizzleSelectChain {
  from: (...args: unknown[]) => DrizzleSelectChain;
  where: (...args: unknown[]) => DrizzleSelectChain;
  orderBy: (...args: unknown[]) => DrizzleSelectChain;
  limit: (...args: unknown[]) => Promise<unknown[]>;
}

interface DrizzleDeleteChain {
  where: (...args: unknown[]) => DrizzleDeleteChain;
  returning: (...args: unknown[]) => Promise<unknown[]>;
}

/**
 * Row shape returned by `search()` — fields mirror the projection in the
 * SELECT statement below. `score` arrives as a JS number from pg but
 * `string | number` covers drivers that surface numerics as strings.
 */
interface PgVectorRow {
  id: string;
  namespace: string;
  metadata: Record<string, unknown> | null;
  content: string | null;
  score: number | string | null;
}

function asDrizzleDb(value: unknown): DrizzleDbLike {
  if (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { insert?: unknown }).insert === "function" &&
    typeof (value as { select?: unknown }).select === "function" &&
    typeof (value as { delete?: unknown }).delete === "function"
  ) {
    return value as DrizzleDbLike;
  }
  throw new Error(
    "PgVectorStore: `db` does not look like a Drizzle DB instance " +
      "(missing insert/select/delete). Pass a value returned by `drizzle(client, …)`.",
  );
}

export interface PgVectorStoreOptions {
  /**
   * Drizzle DB instance (PgDatabase | PgliteDatabase | NodePgDatabase …).
   * Typed as `unknown` to avoid coupling this capability to any specific
   * driver flavour; the constructor narrows it through {@link asDrizzleDb}
   * via a duck-typed check against the `insert / select / delete` surface.
   */
  db: unknown;
  /**
   * Vector dimension. Must match the column type emitted by `./schema.ts`.
   * Defaults to {@link DEFAULT_VECTOR_DIMENSION}.
   */
  dimension?: number;
  /**
   * Override the default chunk size used by {@link PgVectorStore.batchUpsert}.
   * Must be a positive integer; defaults to {@link DEFAULT_BATCH_CHUNK_SIZE}.
   */
  batchChunkSize?: number;
}

export class PgVectorStore implements VectorStore {
  public readonly dimension: number;
  private readonly db: DrizzleDbLike;
  private readonly batchChunkSize: number;

  constructor(options: PgVectorStoreOptions) {
    if (!options?.db) {
      throw new Error("PgVectorStore: `db` is required");
    }
    this.db = asDrizzleDb(options.db);
    this.dimension = options.dimension ?? DEFAULT_VECTOR_DIMENSION;
    if (!Number.isInteger(this.dimension) || this.dimension <= 0) {
      throw new Error("PgVectorStore: dimension must be a positive integer");
    }
    const chunk = options.batchChunkSize ?? DEFAULT_BATCH_CHUNK_SIZE;
    if (!Number.isInteger(chunk) || chunk <= 0) {
      throw new Error("PgVectorStore: batchChunkSize must be a positive integer");
    }
    this.batchChunkSize = chunk;
  }

  async upsert<TMeta extends Record<string, unknown>>(
    input: UpsertVectorInput<TMeta>,
  ): Promise<void> {
    this.assertDimension(input.vector, input.id);
    const namespace = input.namespace ?? DEFAULT_NAMESPACE;

    await this.db
      .insert(vectorsTable)
      .values({
        id: input.id,
        namespace,
        embedding: input.vector,
        metadata: input.metadata,
        content: input.content,
      })
      .onConflictDoUpdate({
        target: [vectorsTable.id, vectorsTable.namespace],
        set: {
          embedding: input.vector,
          metadata: input.metadata,
          content: input.content,
          updatedAt: sql`now()`,
        },
      });
  }

  async batchUpsert<TMeta extends Record<string, unknown>>(
    items: ReadonlyArray<UpsertVectorInput<TMeta>>,
  ): Promise<void> {
    if (items.length === 0) return;
    for (const item of items) {
      this.assertDimension(item.vector, item.id);
    }
    const rows = items.map((item) => ({
      id: item.id,
      namespace: item.namespace ?? DEFAULT_NAMESPACE,
      embedding: item.vector,
      metadata: item.metadata,
      content: item.content,
    }));

    // PostgreSQL caps the bind-parameter count at 65535. Even at ~6
    // parameters per row that's ~10k rows per statement, but providers
    // (pglite, pg-pool) wrap that limit lower in practice. Chunking keeps
    // a single oversize batch from blowing up.
    for (let i = 0; i < rows.length; i += this.batchChunkSize) {
      const chunk = rows.slice(i, i + this.batchChunkSize);
      await this.db
        .insert(vectorsTable)
        .values(chunk)
        .onConflictDoUpdate({
          target: [vectorsTable.id, vectorsTable.namespace],
          set: {
            embedding: sql`excluded.embedding`,
            metadata: sql`excluded.metadata`,
            content: sql`excluded.content`,
            updatedAt: sql`now()`,
          },
        });
    }
  }

  async search<TMeta extends Record<string, unknown> = Record<string, unknown>>(
    queryVector: number[],
    options: VectorSearchOptions = {},
  ): Promise<SimilarityResult<TMeta>[]> {
    this.assertDimension(queryVector, "<query>");
    const namespace = options.namespace ?? DEFAULT_NAMESPACE;
    const topK = clampTopK(options.topK);

    // pgvector accepts the textual `[x,y,z]` form as a `vector` value when
    // the bound parameter is cast with `::vector`. We bind the literal as a
    // standard string parameter — NEVER `sql.raw` — so a hostile component
    // can't smuggle SQL through the query path.
    const queryLiteral = `[${queryVector.join(",")}]`;

    const whereParts = [eq(vectorsTable.namespace, namespace)];
    if (options.filter && Object.keys(options.filter).length > 0) {
      // JSONB containment — `metadata @> $filter`. The filter object is
      // serialised once via JSON.stringify and bound as a parameter so
      // Drizzle handles escaping.
      const filterJson = JSON.stringify(options.filter);
      whereParts.push(sql`${vectorsTable.metadata} @> ${filterJson}::jsonb`);
    }

    // Cosine *distance* in pgvector is `<=>` (range [0, 2]). Cosine
    // *similarity* = 1 - distance lives in [-1, 1]. We rescale to [0, 1]
    // via `(x + 1) / 2`, which matches the in-memory store's
    // `cosineSimilarity()` so `minScore` semantics line up across
    // implementations regardless of which backend the host wires.
    // The score is computed in SQL so ORDER BY can ride the HNSW plan.
    const scoreExpr = sql<number>`((1 - (${vectorsTable.embedding} <=> ${queryLiteral}::vector)) + 1) / 2`;

    const rawRows = await this.db
      .select({
        id: vectorsTable.id,
        namespace: vectorsTable.namespace,
        metadata: vectorsTable.metadata,
        content: vectorsTable.content,
        score: scoreExpr.as("score"),
      })
      .from(vectorsTable)
      .where(and(...whereParts))
      .orderBy(sql`score DESC`)
      .limit(topK);

    const rows = rawRows as PgVectorRow[];
    const minScore = options.minScore;
    const hits: SimilarityResult<TMeta>[] = [];
    for (const row of rows) {
      const score = toFiniteNumber(row.score);
      if (minScore !== undefined && score < minScore) continue;
      hits.push({
        id: row.id,
        namespace: row.namespace,
        score,
        metadata: (row.metadata ?? {}) as TMeta,
        content: row.content ?? undefined,
      });
    }
    return hits;
  }

  async delete(id: string, options: { namespace?: string } = {}): Promise<boolean> {
    const namespace = options.namespace ?? DEFAULT_NAMESPACE;
    const result = await this.db
      .delete(vectorsTable)
      .where(and(eq(vectorsTable.id, id), eq(vectorsTable.namespace, namespace)))
      .returning({ id: vectorsTable.id });
    return Array.isArray(result) && result.length > 0;
  }

  async clearNamespace(namespace: string): Promise<number> {
    const result = await this.db
      .delete(vectorsTable)
      .where(eq(vectorsTable.namespace, namespace))
      .returning({ id: vectorsTable.id });
    return Array.isArray(result) ? result.length : 0;
  }

  /**
   * Validate vector length AND component finiteness. Rejecting NaN /
   * ±Infinity here prevents two failure modes downstream:
   *   1. a malformed pgvector text literal (the wire format truncates
   *      special floats inconsistently across drivers),
   *   2. similarity scores becoming NaN, which would silently sort to
   *      arbitrary positions and corrupt minScore filtering.
   */
  private assertDimension(vector: number[], idForError: string): void {
    if (vector.length !== this.dimension) {
      throw new Error(
        `PgVectorStore: vector for "${idForError}" has length ${vector.length}, expected ${this.dimension}`,
      );
    }
    for (let i = 0; i < vector.length; i++) {
      const v = vector[i];
      if (typeof v !== "number" || !Number.isFinite(v)) {
        throw new Error(
          `PgVectorStore: vector for "${idForError}" has non-finite component at index ${i} (value=${String(v)})`,
        );
      }
    }
  }
}

function clampTopK(value: number | undefined): number {
  const v = value ?? DEFAULT_TOP_K;
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_TOP_K;
  return Math.min(Math.floor(v), MAX_TOP_K);
}

function toFiniteNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** Convenience factory mirroring the capability-level helper. */
export function createPgVectorStore(options: PgVectorStoreOptions): PgVectorStore {
  return new PgVectorStore(options);
}
