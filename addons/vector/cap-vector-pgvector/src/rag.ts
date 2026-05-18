/**
 * Retrieval orchestration helpers for RAG.
 *
 * Spec 68 §3 lays out a full RetrievalService that fuses vector, structural,
 * keyword, and graphql strategies. This file ships the P0 slice — pure
 * vector retrieval plus a prompt-context formatter — and leaves the
 * multi-strategy fusion to a future PR that lands the cap-search /
 * OntologyRegistry hooks (Spec 68 §3 M5-M6 column).
 *
 * `searchSimilar()` is the high-level entry point capability consumers use:
 *   const ctx = await retrieveContext({ store, embedder, query: "…" });
 *   const messages = [{ role: "system", content: ctx.prompt }, …];
 */

import type {
  EmbeddingProvider,
  SearchSimilarOptions,
  SimilarityResult,
  VectorStore,
} from "./types";

// ── searchSimilar ───────────────────────────────────────────

export interface SearchSimilarInput extends SearchSimilarOptions {
  /** Vector store to query. */
  store: VectorStore;
  /** Embedding provider used when `queryVector` is not pre-computed. */
  embedder?: EmbeddingProvider;
  /** Natural-language query. Required unless `queryVector` is supplied. */
  query?: string;
}

/**
 * Convenience wrapper around `VectorStore.search()` that accepts either a
 * pre-computed embedding (`queryVector`) or a natural-language `query`
 * which is embedded on the fly via the supplied `embedder`.
 */
export async function searchSimilar<
  TMeta extends Record<string, unknown> = Record<string, unknown>,
>(input: SearchSimilarInput): Promise<SimilarityResult<TMeta>[]> {
  const { store, embedder, query, queryVector, ...searchOptions } = input;
  const vector = queryVector ?? (await embedQuery(query, embedder));
  if (!vector) {
    throw new Error("searchSimilar: provide either `queryVector` or both `query` and `embedder`");
  }
  return store.search<TMeta>(vector, searchOptions);
}

async function embedQuery(
  query: string | undefined,
  embedder: EmbeddingProvider | undefined,
): Promise<number[] | undefined> {
  if (!query || !embedder) return undefined;
  return embedder.embed(query);
}

// ── retrieveContext (RAG prompt builder) ────────────────────

export interface RetrieveContextInput<TMeta extends Record<string, unknown>>
  extends SearchSimilarInput {
  /** Reserved for the per-hit formatter generic. */
  _meta?: TMeta;
  /** Maximum number of characters embedded into the final prompt block. */
  maxChars?: number;
  /** Header line prepended to the formatted context. */
  header?: string;
  /**
   * Custom formatter for a single hit. Receives the hit and its 1-based
   * index in the result list; should return the text for that snippet.
   * Defaults to `"[#i] {content}"` with the metadata appended on a tail
   * line if present.
   */
  formatHit?: (hit: SimilarityResult<TMeta>, index: number) => string;
}

export interface RetrieveContextResult<TMeta extends Record<string, unknown>> {
  /** Formatted prompt block ready to splice into a system / user message. */
  prompt: string;
  /** Raw hits used to build the prompt (post topK / minScore filtering). */
  hits: SimilarityResult<TMeta>[];
  /** Total characters in the prompt (≤ `maxChars`). */
  charCount: number;
}

const DEFAULT_HEADER = "Context retrieved from the knowledge base:";
const DEFAULT_MAX_CHARS = 4_000;

/**
 * Fetch top-K hits and format them into a single prompt-context string.
 *
 * The default formatter produces one block per hit:
 *
 *   [#1] {content || metadata.summary}
 *
 * Hits are appended in score order until the cumulative character count
 * reaches `maxChars`. The cut-off is greedy — a hit either fits whole or
 * is skipped — so chunks stay intact and the LLM never sees a half-line.
 */
export async function retrieveContext<
  TMeta extends Record<string, unknown> = Record<string, unknown>,
>(input: RetrieveContextInput<TMeta>): Promise<RetrieveContextResult<TMeta>> {
  const hits = await searchSimilar<TMeta>(input);
  const header = input.header ?? DEFAULT_HEADER;
  const maxChars = Math.max(64, input.maxChars ?? DEFAULT_MAX_CHARS);
  const formatHit = input.formatHit ?? defaultFormatHit;

  if (hits.length === 0) {
    const empty = `${header}\n(no relevant context found)`;
    return { prompt: empty, hits, charCount: empty.length };
  }

  const parts: string[] = [header];
  let total = header.length;
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i];
    if (!hit) continue;
    const block = formatHit(hit, i + 1);
    // +1 for the join "\n" separator that will sit between blocks.
    const cost = block.length + 1;
    if (total + cost > maxChars) break;
    parts.push(block);
    total += cost;
  }

  const prompt = parts.join("\n");
  return { prompt, hits, charCount: prompt.length };
}

function defaultFormatHit<TMeta extends Record<string, unknown>>(
  hit: SimilarityResult<TMeta>,
  index: number,
): string {
  const body =
    hit.content && hit.content.length > 0
      ? hit.content
      : (extractSummary(hit.metadata) ?? `(no content; id=${hit.id})`);
  return `[#${index}] ${body}`;
}

function extractSummary(metadata: Record<string, unknown>): string | undefined {
  for (const key of ["summary", "description", "title"]) {
    const v = metadata[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}
