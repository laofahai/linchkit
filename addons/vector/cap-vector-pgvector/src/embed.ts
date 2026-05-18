/**
 * Embedding pipeline — turns records / documents into upsert payloads.
 *
 * Two concerns live here:
 *
 *  1. `createFunctionEmbeddingProvider()` — adapt an arbitrary embed
 *     function (e.g. Vercel AI SDK's `embed()` / `embedMany()`) into the
 *     {@link EmbeddingProvider} contract this capability consumes.
 *
 *  2. `embedAndUpsertDocuments()` — convenience pipeline that, given a
 *     batch of `DocumentInput`, embeds every document via the provider
 *     and writes the rows into a {@link VectorStore} in one round-trip.
 *
 * The capability deliberately does NOT bind to `@linchkit/cap-ai-provider`
 * directly. Hosts wire the embedding source they prefer: that keeps this
 * package importable in tests with zero AI configuration (the test fixture
 * passes a deterministic stub provider).
 */

import type { EmbeddingProvider, UpsertVectorInput, VectorStore } from "./types";

// ── Function adapter ────────────────────────────────────────

/**
 * Default concurrency for the synthesised `embedMany` fallback.
 *
 * Most hosted embedding endpoints (OpenAI, Cohere, voyage) tolerate
 * 4-8 concurrent requests before tripping the per-second token-bucket;
 * 4 is conservative without serialising. Hosts that want different
 * behaviour either supply a native `embedMany` or override
 * {@link FunctionEmbeddingProviderOptions.embedManyConcurrency}.
 */
const DEFAULT_EMBED_MANY_CONCURRENCY = 4;

export interface FunctionEmbeddingProviderOptions {
  /** Vector dimension produced by the embed function. */
  dimension: number;
  /** Single-text embedding function. */
  embed: (text: string) => Promise<number[]>;
  /**
   * Optional batch variant. When omitted, `embedMany()` falls back to a
   * concurrency-limited loop over `embed()` (see
   * {@link embedManyConcurrency}).
   */
  embedMany?: (texts: readonly string[]) => Promise<number[][]>;
  /**
   * Maximum number of concurrent `embed()` calls when `embedMany` falls
   * back. Ignored when a native `embedMany` is supplied. Must be a
   * positive integer; defaults to {@link DEFAULT_EMBED_MANY_CONCURRENCY}.
   */
  embedManyConcurrency?: number;
}

/**
 * Wrap a plain embed function (e.g. Vercel AI SDK) as an EmbeddingProvider.
 *
 * @example
 * ```ts
 * import { embed } from "ai";
 * import { openai } from "@ai-sdk/openai";
 *
 * const model = openai.textEmbeddingModel("text-embedding-3-small");
 * const provider = createFunctionEmbeddingProvider({
 *   dimension: 1536,
 *   embed: async (text) => (await embed({ model, value: text })).embedding,
 * });
 * ```
 */
export function createFunctionEmbeddingProvider(
  options: FunctionEmbeddingProviderOptions,
): EmbeddingProvider {
  if (!Number.isInteger(options.dimension) || options.dimension <= 0) {
    throw new Error("createFunctionEmbeddingProvider: dimension must be a positive integer");
  }
  const concurrency = options.embedManyConcurrency ?? DEFAULT_EMBED_MANY_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new Error(
      "createFunctionEmbeddingProvider: embedManyConcurrency must be a positive integer",
    );
  }

  return {
    dimension: options.dimension,
    embed: options.embed,
    embedMany:
      options.embedMany ??
      (async (texts) => {
        // Fallback path: dispatch `embed()` with a bounded concurrency
        // pool so a large `documents` array doesn't open hundreds of
        // simultaneous HTTP requests and trip the provider's rate limit.
        return runWithConcurrency(texts, concurrency, options.embed);
      }),
  };
}

/**
 * Run `task` over every input with at most `limit` in-flight promises,
 * preserving input order in the output array.
 *
 * Kept inline (no extra dep) — the implementation is a simple sliding
 * window over a worker pool.
 */
async function runWithConcurrency<TIn, TOut>(
  inputs: readonly TIn[],
  limit: number,
  task: (input: TIn) => Promise<TOut>,
): Promise<TOut[]> {
  if (inputs.length === 0) return [];
  const effectiveLimit = Math.max(1, Math.min(limit, inputs.length));
  const results = new Array<TOut>(inputs.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor++;
      if (idx >= inputs.length) return;
      results[idx] = await task(inputs[idx] as TIn);
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < effectiveLimit; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

// ── Document → vector pipeline ──────────────────────────────

/** One source document to embed and persist. */
export interface DocumentInput<TMeta extends Record<string, unknown> = Record<string, unknown>> {
  /** Stable record id; reused as the upsert key. */
  id: string;
  /** Raw text to embed. */
  content: string;
  /** Metadata persisted alongside the embedding. */
  metadata?: TMeta;
  /** Optional namespace override (defaults to the pipeline-wide `namespace`). */
  namespace?: string;
}

export interface EmbedAndUpsertOptions<TMeta extends Record<string, unknown>> {
  /** Vector store to write into. */
  store: VectorStore;
  /** Provider used to compute embeddings. */
  embedder: EmbeddingProvider;
  /** Documents to embed and upsert. */
  documents: ReadonlyArray<DocumentInput<TMeta>>;
  /** Default namespace for documents that don't supply one. */
  namespace?: string;
}

/**
 * Embed every document and upsert into the vector store as a single batch.
 * Returns the number of rows written so callers can log it.
 */
export async function embedAndUpsertDocuments<TMeta extends Record<string, unknown>>(
  options: EmbedAndUpsertOptions<TMeta>,
): Promise<number> {
  const { store, embedder, documents, namespace } = options;
  if (documents.length === 0) return 0;
  if (embedder.dimension !== store.dimension) {
    throw new Error(
      `embedAndUpsertDocuments: embedder.dimension (${embedder.dimension}) != store.dimension (${store.dimension})`,
    );
  }

  // Prefer the batch path so providers with bulk endpoints can amortise
  // network latency. The function-adapter wrapper above guarantees
  // embedMany() always exists.
  const texts = documents.map((d) => d.content);
  const vectors = embedder.embedMany
    ? await embedder.embedMany(texts)
    : await Promise.all(texts.map((t) => embedder.embed(t)));

  if (vectors.length !== documents.length) {
    throw new Error(
      `embedAndUpsertDocuments: embedder returned ${vectors.length} vectors for ${documents.length} documents`,
    );
  }

  const items: UpsertVectorInput<TMeta>[] = documents.map((doc, idx) => {
    const vector = vectors[idx];
    if (!vector || vector.length !== embedder.dimension) {
      throw new Error(
        `embedAndUpsertDocuments: vector ${idx} has unexpected length (got ${vector?.length ?? 0}, expected ${embedder.dimension})`,
      );
    }
    return {
      id: doc.id,
      vector,
      metadata: (doc.metadata ?? ({} as TMeta)) as TMeta,
      content: doc.content,
      namespace: doc.namespace ?? namespace,
    };
  });

  await store.batchUpsert(items);
  return items.length;
}
