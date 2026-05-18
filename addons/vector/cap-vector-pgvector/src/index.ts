/**
 * @linchkit/cap-vector-pgvector — public API
 *
 * Exports the VectorStore contract, the pgvector + in-memory
 * implementations, the embedding pipeline, the RAG retrieval helpers,
 * and the capability factory used by host applications.
 *
 * Spec 68 reference:
 *  - §2.1 — VectorStore interface (here in `./types.ts`, see comment for
 *    why we deferred promoting it to `@linchkit/core`).
 *  - §2.2 — pgvector capability + HNSW index (here in `./schema.ts`).
 *  - §2.3 — Embedding strategy (here in `./embed.ts`).
 *  - §3   — Retrieval orchestration (P0 slice in `./rag.ts`).
 */

export type { CapVectorPgvectorOptions } from "./capability";
export { capVectorPgvector, createCapVectorPgvector } from "./capability";

// Embedding pipeline
export type {
  DocumentInput,
  EmbedAndUpsertOptions,
  FunctionEmbeddingProviderOptions,
} from "./embed";
export { createFunctionEmbeddingProvider, embedAndUpsertDocuments } from "./embed";
export { InMemoryVectorStore, type InMemoryVectorStoreOptions } from "./in-memory-store";

// Store implementations
export { createPgVectorStore, PgVectorStore, type PgVectorStoreOptions } from "./pgvector-store";

// RAG retrieval helpers
export type {
  RetrieveContextInput,
  RetrieveContextResult,
  SearchSimilarInput,
} from "./rag";
export { retrieveContext, searchSimilar } from "./rag";

// Drizzle schema + constants
export {
  DEFAULT_NAMESPACE,
  DEFAULT_VECTOR_DIMENSION,
  vectorColumn,
  vectorsTable,
} from "./schema";

// Public types
export type {
  EmbeddingProvider,
  SearchSimilarOptions,
  SimilarityResult,
  UpsertVectorInput,
  VectorSearchOptions,
  VectorStore,
} from "./types";

// Math helpers (exported for consumers that want to reproduce scoring)
export { cosineSimilarity, matchesFilter } from "./vector-math";
