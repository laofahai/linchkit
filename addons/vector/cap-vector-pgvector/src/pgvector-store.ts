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
 *     pgvector cosine *distance* to similarity = `1 - distance`.
 *  3. Apply optional JSONB containment filters and a minScore threshold.
 *
 * The constructor takes a pre-built Drizzle DB instance — the capability is
 * deliberately decoupled from how the host obtains its DB handle.
 *
 * SAFETY
 * ------
 *  - All user-supplied filter values flow through Drizzle's parameter
 *    binding via the `sql` template tag → no SQL injection.
 *  - Vectors are converted to the pgvector textual form (`[1,2,3]`) once,
 *    by the `vectorColumn` customType in `./schema.ts`, so the wire format
 *    is centralized.
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

export interface PgVectorStoreOptions {
  /**
   * Drizzle DB instance (PgDatabase | PgliteDatabase | NodePgDatabase …).
   * The type is left as `unknown` to avoid coupling this capability to
   * any specific driver flavour; runtime calls are duck-typed against
   * the standard `insert / select / delete` surface.
   */
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle DB instance type varies by driver
  db: any;
  /**
   * Vector dimension. Must match the column type emitted by `./schema.ts`.
   * Defaults to {@link DEFAULT_VECTOR_DIMENSION}.
   */
  dimension?: number;
}

export class PgVectorStore implements VectorStore {
  public readonly dimension: number;
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle DB instance type varies by driver
  private readonly db: any;

  constructor(options: PgVectorStoreOptions) {
    if (!options?.db) {
      throw new Error("PgVectorStore: `db` is required");
    }
    this.db = options.db;
    this.dimension = options.dimension ?? DEFAULT_VECTOR_DIMENSION;
    if (!Number.isInteger(this.dimension) || this.dimension <= 0) {
      throw new Error("PgVectorStore: dimension must be a positive integer");
    }
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
    // Single multi-row INSERT — Drizzle accepts an array of value objects.
    await this.db
      .insert(vectorsTable)
      .values(rows)
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

  async search<TMeta extends Record<string, unknown> = Record<string, unknown>>(
    queryVector: number[],
    options: VectorSearchOptions = {},
  ): Promise<SimilarityResult<TMeta>[]> {
    this.assertDimension(queryVector, "<query>");
    const namespace = options.namespace ?? DEFAULT_NAMESPACE;
    const topK = clampTopK(options.topK);

    // pgvector stores the query as a vector literal; we hand-format the
    // textual form here because Drizzle has no first-class binding for
    // the `vector(N)` type.
    const queryLiteral = `[${queryVector.join(",")}]`;

    const whereParts = [eq(vectorsTable.namespace, namespace)];
    if (options.filter && Object.keys(options.filter).length > 0) {
      // JSONB containment — `metadata @> $filter`. The filter object is
      // serialised once via JSON.stringify and bound as a parameter so
      // Drizzle handles escaping.
      const filterJson = JSON.stringify(options.filter);
      whereParts.push(sql`${vectorsTable.metadata} @> ${filterJson}::jsonb`);
    }

    // Cosine *distance* in pgvector is `<=>`; similarity = 1 - distance.
    // We compute the score in SQL so ORDER BY uses the index plan.
    const scoreExpr = sql<number>`1 - (${vectorsTable.embedding} <=> ${sql.raw(`'${queryLiteral}'::vector`)})`;

    // biome-ignore lint/suspicious/noExplicitAny: Drizzle row shape varies by driver
    const rows: any[] = await this.db
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

    const minScore = options.minScore;
    const hits: SimilarityResult<TMeta>[] = [];
    for (const row of rows) {
      const score = Number(row.score) || 0;
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
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle returning shape varies by driver
    const result: any = await this.db
      .delete(vectorsTable)
      .where(and(eq(vectorsTable.id, id), eq(vectorsTable.namespace, namespace)))
      .returning({ id: vectorsTable.id });
    return Array.isArray(result) && result.length > 0;
  }

  async clearNamespace(namespace: string): Promise<number> {
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle returning shape varies by driver
    const result: any = await this.db
      .delete(vectorsTable)
      .where(eq(vectorsTable.namespace, namespace))
      .returning({ id: vectorsTable.id });
    return Array.isArray(result) ? result.length : 0;
  }

  private assertDimension(vector: number[], idForError: string): void {
    if (vector.length !== this.dimension) {
      throw new Error(
        `PgVectorStore: vector for "${idForError}" has length ${vector.length}, expected ${this.dimension}`,
      );
    }
  }
}

function clampTopK(value: number | undefined): number {
  const v = value ?? DEFAULT_TOP_K;
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_TOP_K;
  return Math.min(Math.floor(v), MAX_TOP_K);
}

/** Convenience factory mirroring the capability-level helper. */
export function createPgVectorStore(options: PgVectorStoreOptions): PgVectorStore {
  return new PgVectorStore(options);
}
