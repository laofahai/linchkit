/**
 * Public types for @linchkit/cap-vector-pgvector.
 *
 * Hosts the VectorStore contract and the embedding-provider adapter used by
 * the pgvector implementation. The contract follows Spec 68 §2.1 closely but
 * lives in the capability rather than `@linchkit/core` for now:
 *
 *  - Spec 56 (core slimming) keeps optional infrastructure out of core.
 *  - There is only one VectorStore implementation in-tree today
 *    (`cap-vector-pgvector`), so promoting the interface to core would
 *    create import drag without buyers.
 *  - When `cap-vector-memory` / `cap-vector-qdrant` land, this file moves
 *    to `@linchkit/core/vector` and other capabilities re-export from
 *    there. Until then the contract lives next to its only consumer.
 */

// ── Embedding adapter ───────────────────────────────────────

/**
 * Minimal embedding-provider contract that VectorStore depends on.
 *
 * The capability deliberately does NOT depend on `@linchkit/cap-ai-provider`
 * directly — hosts wire whatever embedding source they prefer (OpenAI,
 * Anthropic, local model, even a stub returning zero vectors for tests).
 *
 * Spec 68 §2.3: "复用 cap-ai-provider … VectorStore 的 embed() 实现委托给
 * AI Provider." The implementation of that delegation is the host's job,
 * not this capability's — see `createAiProviderEmbeddingProvider()` in
 * `./embed.ts` for the canonical wiring helper.
 */
export interface EmbeddingProvider {
  /** Embedding dimension produced by `embed()` (e.g. 1536 for OpenAI text-embedding-3-small). */
  readonly dimension: number;
  /** Compute the embedding vector for a single text. */
  embed(text: string): Promise<number[]>;
  /**
   * Compute embeddings for a batch of texts. Implementations that lack a
   * native batch API can fall back to a sequential / Promise.all loop.
   */
  embedMany?(texts: readonly string[]): Promise<number[][]>;
}

// ── Vector store contract ───────────────────────────────────

/** A single similarity hit returned by `VectorStore.search()`. */
export interface SimilarityResult<TMeta extends Record<string, unknown> = Record<string, unknown>> {
  /** Caller-supplied row identifier. */
  id: string;
  /**
   * Cosine similarity score in `[0, 1]`. Higher = more similar.
   * (Postgres pgvector's `<=>` returns cosine *distance*; the store
   * converts it to similarity = `1 - distance` before returning.)
   */
  score: number;
  /** Metadata stored at `upsert()` time. */
  metadata: TMeta;
  /** Optional original text content, when stored. */
  content?: string;
  /** Namespace this row belongs to. */
  namespace: string;
}

/** Options accepted by `VectorStore.search()`. */
export interface VectorSearchOptions {
  /** Maximum number of results to return (defaults to 10, hard-capped at 200). */
  topK?: number;
  /**
   * Namespace scope. Defaults to `"default"`. Mirrors the spec's tenant /
   * collection separation — `meta_model` for ontology vectors,
   * `data:{entity_name}` for business rows, etc.
   */
  namespace?: string;
  /**
   * Metadata equality filter applied as a JSONB containment match
   * (`metadata @> filter`). Each top-level key must equal the supplied
   * value for the row to qualify.
   */
  filter?: Record<string, unknown>;
  /** Minimum similarity score in `[0, 1]`. Results below the threshold are dropped. */
  minScore?: number;
}

/** Options accepted by `searchSimilar()` / `retrieveContext()` orchestration helpers. */
export interface SearchSimilarOptions extends VectorSearchOptions {
  /** Pre-computed query embedding. When omitted, `embedder.embed(query)` is used. */
  queryVector?: number[];
}

/** Input row for `VectorStore.upsert()` / `batchUpsert()`. */
export interface UpsertVectorInput<
  TMeta extends Record<string, unknown> = Record<string, unknown>,
> {
  /** Caller-supplied row identifier; reused as the upsert conflict target. */
  id: string;
  /** Embedding vector. Length must match the store's dimension. */
  vector: number[];
  /** Arbitrary metadata persisted alongside the vector. */
  metadata: TMeta;
  /** Original text content (optional but recommended for RAG). */
  content?: string;
  /** Namespace bucket. Defaults to `"default"`. */
  namespace?: string;
}

/**
 * Abstract vector-storage service used by the evolution system, Meta-Model
 * semantic layer, AI code generation, and Chatter RAG.
 *
 * Implementations:
 *  - `PgVectorStore` — PostgreSQL `vector` extension via Drizzle.
 *  - `InMemoryVectorStore` — brute-force KNN for tests / dev. Doubles as
 *    the Spec 68 §2.2 `cap-vector-memory` implementation.
 */
export interface VectorStore {
  /** Vector dimension this store was configured for. */
  readonly dimension: number;
  /** Insert or update a single row. Conflict target is `(id, namespace)`. */
  upsert<TMeta extends Record<string, unknown>>(input: UpsertVectorInput<TMeta>): Promise<void>;
  /** Bulk variant of `upsert()` — implementations should run a single round-trip when possible. */
  batchUpsert<TMeta extends Record<string, unknown>>(
    items: ReadonlyArray<UpsertVectorInput<TMeta>>,
  ): Promise<void>;
  /** Similarity search using the supplied query vector. */
  search<TMeta extends Record<string, unknown> = Record<string, unknown>>(
    queryVector: number[],
    options?: VectorSearchOptions,
  ): Promise<SimilarityResult<TMeta>[]>;
  /** Delete a single row by id within a namespace. Returns `true` if the row existed. */
  delete(id: string, options?: { namespace?: string }): Promise<boolean>;
  /** Drop every row in a namespace. Useful for tests and namespace recycling. */
  clearNamespace(namespace: string): Promise<number>;
}
