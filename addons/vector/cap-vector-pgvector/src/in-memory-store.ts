/**
 * InMemoryVectorStore — brute-force KNN, no database required.
 *
 * Used by:
 *  - unit tests for the capability and its consumers,
 *  - dev environments without pgvector,
 *  - Spec 68 §2.2's `cap-vector-memory` use case (no separate package
 *    needed yet — re-export this class from there when it ships).
 *
 * Brute-force cosine similarity is O(N * D) per query. That's fine for
 * the typical test fixture (≤ 10k vectors); production deployments must
 * use `PgVectorStore` so HNSW kicks in.
 */

import type {
  SimilarityResult,
  UpsertVectorInput,
  VectorSearchOptions,
  VectorStore,
} from "./types";
import { cosineSimilarity, matchesFilter } from "./vector-math";

interface StoredRow {
  id: string;
  namespace: string;
  vector: number[];
  metadata: Record<string, unknown>;
  content?: string;
}

const DEFAULT_NAMESPACE = "default";
const DEFAULT_TOP_K = 10;
const MAX_TOP_K = 200;

export interface InMemoryVectorStoreOptions {
  /** Vector dimension. Defaults to 1536 to match the pgvector default. */
  dimension?: number;
}

export class InMemoryVectorStore implements VectorStore {
  public readonly dimension: number;
  /** Key is `${namespace}::${id}` so the same id can live in two namespaces. */
  private readonly rows = new Map<string, StoredRow>();

  constructor(options: InMemoryVectorStoreOptions = {}) {
    this.dimension = options.dimension ?? 1536;
    if (!Number.isInteger(this.dimension) || this.dimension <= 0) {
      throw new Error("InMemoryVectorStore: dimension must be a positive integer");
    }
  }

  async upsert<TMeta extends Record<string, unknown>>(
    input: UpsertVectorInput<TMeta>,
  ): Promise<void> {
    this.assertDimension(input.vector, input.id);
    const namespace = input.namespace ?? DEFAULT_NAMESPACE;
    this.rows.set(rowKey(input.id, namespace), {
      id: input.id,
      namespace,
      vector: [...input.vector],
      metadata: { ...input.metadata },
      content: input.content,
    });
  }

  async batchUpsert<TMeta extends Record<string, unknown>>(
    items: ReadonlyArray<UpsertVectorInput<TMeta>>,
  ): Promise<void> {
    for (const item of items) {
      await this.upsert(item);
    }
  }

  async search<TMeta extends Record<string, unknown> = Record<string, unknown>>(
    queryVector: number[],
    options: VectorSearchOptions = {},
  ): Promise<SimilarityResult<TMeta>[]> {
    this.assertDimension(queryVector, "<query>");
    const namespace = options.namespace ?? DEFAULT_NAMESPACE;
    const topK = clampTopK(options.topK);
    const minScore = options.minScore ?? Number.NEGATIVE_INFINITY;
    const filter = options.filter;

    const candidates: SimilarityResult<TMeta>[] = [];
    for (const row of this.rows.values()) {
      if (row.namespace !== namespace) continue;
      if (filter && !matchesFilter(row.metadata, filter)) continue;
      const score = cosineSimilarity(queryVector, row.vector);
      if (score < minScore) continue;
      candidates.push({
        id: row.id,
        score,
        metadata: row.metadata as TMeta,
        content: row.content,
        namespace: row.namespace,
      });
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, topK);
  }

  async delete(id: string, options: { namespace?: string } = {}): Promise<boolean> {
    const namespace = options.namespace ?? DEFAULT_NAMESPACE;
    return this.rows.delete(rowKey(id, namespace));
  }

  async clearNamespace(namespace: string): Promise<number> {
    let count = 0;
    for (const key of [...this.rows.keys()]) {
      const row = this.rows.get(key);
      if (row && row.namespace === namespace) {
        this.rows.delete(key);
        count++;
      }
    }
    return count;
  }

  /** Test helper — total stored rows across all namespaces. */
  size(): number {
    return this.rows.size;
  }

  private assertDimension(vector: number[], idForError: string): void {
    if (vector.length !== this.dimension) {
      throw new Error(
        `InMemoryVectorStore: vector for "${idForError}" has length ${vector.length}, expected ${this.dimension}`,
      );
    }
  }
}

function rowKey(id: string, namespace: string): string {
  return `${namespace}::${id}`;
}

function clampTopK(value: number | undefined): number {
  const v = value ?? DEFAULT_TOP_K;
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_TOP_K;
  return Math.min(Math.floor(v), MAX_TOP_K);
}
