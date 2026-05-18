# @linchkit/cap-vector-pgvector

PostgreSQL `pgvector` implementation of LinchKit's `VectorStore` contract — see
[Spec 68 — Vector Store & RAG](../../../docs/specs/68_vector_store.md).

The capability provides:

- `VectorStore` contract (in `./src/types.ts` for now — promoted to core once
  a second implementation lands; see file header for the rationale).
- `PgVectorStore` — Drizzle-backed implementation using the `vector(N)`
  column type, `<=>` cosine distance operator, and HNSW index.
- `InMemoryVectorStore` — brute-force KNN for tests / dev environments and a
  zero-config stand-in for the spec's `cap-vector-memory`.
- Embedding pipeline (`embedAndUpsertDocuments`) that accepts any
  `EmbeddingProvider`. A `createFunctionEmbeddingProvider()` helper wraps
  arbitrary embed functions (e.g. Vercel AI SDK).
- RAG helpers (`searchSimilar`, `retrieveContext`) — the P0 single-strategy
  retrieval slice. Multi-strategy fusion (Spec 68 §3.2) is deferred.

## Database setup

Two SQL steps run alongside drizzle-kit's generated `CREATE TABLE`:

```sql
-- 1. Enable the extension (run once per database)
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Create the HNSW + cosine_ops index (drizzle-kit cannot express
--    the operator class, so the capability ships this SQL by hand)
CREATE INDEX IF NOT EXISTS idx_vectors_embedding_hnsw
  ON _linchkit.vectors
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 200);
```

Steps to wire the table itself into a host application:

1. Add `cap-vector-pgvector` to `linchkit.config.ts`.
2. Run `bun run db:generate` — this regenerates the Drizzle schema barrel
   and invokes drizzle-kit to emit the `CREATE TABLE _linchkit.vectors`
   migration.
3. Apply the migration plus the two SQL statements above.

## Usage

```ts
import { createCapVectorPgvector, createFunctionEmbeddingProvider, retrieveContext }
  from "@linchkit/cap-vector-pgvector";

const capVector = createCapVectorPgvector({ db });

const embedder = createFunctionEmbeddingProvider({
  dimension: 1536,
  embed: async (text) => /* call OpenAI / Anthropic / local model */,
});

const { prompt, hits } = await retrieveContext({
  store: capVector.vectorStore,
  embedder,
  query: "approval rules for capital expenditure",
  topK: 5,
  namespace: "meta_model",
});
```

## Deferred (out of scope for this PR)

- Multi-strategy retrieval orchestration (vector + structural + keyword) —
  Spec 68 §3.1, lands once cap-search hooks are wired.
- Auto-vectorization of Meta-Model definitions and business data — Spec 68
  §4, lands as a follow-up event-handler in the same package.
- RAG quality metrics (context_recall, faithfulness …) — Spec 68 §6.
- Reranking and reciprocal rank fusion — Spec 68 §3 M6+ column.
- Dedicated `cap-vector-memory` / `cap-vector-qdrant` packages — Spec 68
  §2.2 future row. `InMemoryVectorStore` already covers the M5
  test-only need.
