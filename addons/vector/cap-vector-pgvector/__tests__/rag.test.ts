/**
 * RAG helper tests — verifies the searchSimilar / retrieveContext entry
 * points against the in-memory store, with a deterministic stub embedder.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { createFunctionEmbeddingProvider } from "../src/embed";
import { InMemoryVectorStore } from "../src/in-memory-store";
import { retrieveContext, searchSimilar } from "../src/rag";

const D = 3;

function stubEmbed(text: string): number[] {
  const buckets = [0, 0, 0];
  for (let i = 0; i < text.length; i++) {
    buckets[i % 3] += text.charCodeAt(i);
  }
  return buckets;
}

describe("searchSimilar", () => {
  let store: InMemoryVectorStore;

  beforeEach(async () => {
    store = new InMemoryVectorStore({ dimension: D });
    await store.upsert({
      id: "doc-a",
      vector: stubEmbed("alpha bravo charlie"),
      metadata: {},
      content: "alpha bravo charlie",
    });
    await store.upsert({
      id: "doc-b",
      vector: stubEmbed("delta echo foxtrot"),
      metadata: {},
      content: "delta echo foxtrot",
    });
  });

  it("embeds the query string when queryVector is omitted", async () => {
    const embedder = createFunctionEmbeddingProvider({
      dimension: D,
      embed: async (text) => stubEmbed(text),
    });
    const hits = await searchSimilar({
      store,
      embedder,
      query: "alpha bravo charlie",
    });
    expect(hits[0]?.id).toBe("doc-a");
  });

  it("accepts a pre-computed queryVector and skips the embedder", async () => {
    const hits = await searchSimilar({
      store,
      queryVector: stubEmbed("delta echo foxtrot"),
    });
    expect(hits[0]?.id).toBe("doc-b");
  });

  it("throws when neither query+embedder nor queryVector is supplied", async () => {
    await expect(searchSimilar({ store })).rejects.toThrow(/queryVector/);
  });
});

describe("retrieveContext", () => {
  let store: InMemoryVectorStore;

  beforeEach(async () => {
    store = new InMemoryVectorStore({ dimension: D });
    await store.upsert({
      id: "1",
      vector: stubEmbed("first chunk text"),
      metadata: {},
      content: "first chunk text",
    });
    await store.upsert({
      id: "2",
      vector: stubEmbed("second chunk text"),
      metadata: {},
      content: "second chunk text",
    });
  });

  it("formats hits into a numbered prompt block", async () => {
    const result = await retrieveContext({
      store,
      queryVector: stubEmbed("first chunk text"),
      topK: 2,
    });
    expect(result.hits).toHaveLength(2);
    expect(result.prompt).toContain("[#1]");
    expect(result.prompt).toContain("first chunk text");
    expect(result.charCount).toBe(result.prompt.length);
  });

  it("returns a `no relevant context found` block when there are no hits", async () => {
    const empty = new InMemoryVectorStore({ dimension: D });
    const result = await retrieveContext({
      store: empty,
      queryVector: stubEmbed("anything"),
    });
    expect(result.hits).toHaveLength(0);
    expect(result.prompt).toContain("no relevant context found");
  });

  it("honors maxChars by greedily dropping hits that would overflow", async () => {
    // The prompt fits exactly the header + one block; the second block
    // would push past maxChars and is skipped intact.
    const result = await retrieveContext({
      store,
      queryVector: stubEmbed("first chunk text"),
      topK: 2,
      maxChars: 80,
    });
    expect(result.prompt.length).toBeLessThanOrEqual(80);
    // At least one of the two hits made it into the prompt
    expect(result.prompt).toContain("[#1]");
  });

  it("uses a custom formatHit when supplied", async () => {
    const result = await retrieveContext({
      store,
      queryVector: stubEmbed("first chunk text"),
      topK: 1,
      formatHit: (hit, index) => `>>> ${index} :: ${hit.id} :: ${hit.score.toFixed(2)}`,
    });
    expect(result.prompt).toContain(">>> 1 :: ");
  });

  it("falls back to metadata.summary when content is missing", async () => {
    const s = new InMemoryVectorStore({ dimension: D });
    await s.upsert({
      id: "ref",
      vector: stubEmbed("anything"),
      metadata: { summary: "fallback summary text" },
    });

    const result = await retrieveContext({
      store: s,
      queryVector: stubEmbed("anything"),
      topK: 1,
    });
    expect(result.prompt).toContain("fallback summary text");
  });
});
