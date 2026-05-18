/**
 * Embedding pipeline tests — covers the function-adapter wrapper and the
 * batch `embedAndUpsertDocuments` pipeline. A deterministic stub embedder
 * keeps the assertions math-free.
 */

import { describe, expect, it } from "bun:test";
import { createFunctionEmbeddingProvider, embedAndUpsertDocuments } from "../src/embed";
import { InMemoryVectorStore } from "../src/in-memory-store";

const D = 3;

/**
 * Hash a text into a deterministic 3-d vector for testing.
 * Positional buckets so different texts produce non-parallel vectors
 * (cosine similarity can actually differentiate them).
 */
function stubEmbed(text: string): number[] {
  const buckets = [0, 0, 0];
  for (let i = 0; i < text.length; i++) {
    buckets[i % 3] += text.charCodeAt(i);
  }
  return buckets;
}

describe("createFunctionEmbeddingProvider", () => {
  it("synthesises embedMany when only embed is supplied", async () => {
    const provider = createFunctionEmbeddingProvider({
      dimension: D,
      embed: async (text) => stubEmbed(text),
    });
    const [u, v] = (await provider.embedMany?.(["hi", "ho"])) ?? [];
    expect(u).toEqual(stubEmbed("hi"));
    expect(v).toEqual(stubEmbed("ho"));
  });

  it("uses the caller-supplied embedMany when provided", async () => {
    let batchCalls = 0;
    const provider = createFunctionEmbeddingProvider({
      dimension: D,
      embed: async (text) => stubEmbed(text),
      embedMany: async (texts) => {
        batchCalls++;
        return texts.map((t) => stubEmbed(t));
      },
    });
    await provider.embedMany?.(["a", "b", "c"]);
    expect(batchCalls).toBe(1);
  });

  it("rejects non-positive dimension", () => {
    expect(() => createFunctionEmbeddingProvider({ dimension: 0, embed: async () => [] })).toThrow(
      /positive integer/,
    );
  });
});

describe("embedAndUpsertDocuments", () => {
  it("embeds every document and persists them under the supplied namespace", async () => {
    const store = new InMemoryVectorStore({ dimension: D });
    const embedder = createFunctionEmbeddingProvider({
      dimension: D,
      embed: async (text) => stubEmbed(text),
    });

    const count = await embedAndUpsertDocuments({
      store,
      embedder,
      namespace: "meta_model",
      documents: [
        { id: "entity:order", content: "order entity description" },
        { id: "entity:vendor", content: "vendor entity description", metadata: { kind: "ref" } },
      ],
    });

    expect(count).toBe(2);
    expect(store.size()).toBe(2);

    // The vendor row carried metadata through to the store.
    const hits = await store.search(stubEmbed("vendor entity description"), {
      namespace: "meta_model",
    });
    expect(hits[0]?.id).toBe("entity:vendor");
    expect(hits[0]?.metadata.kind).toBe("ref");
    expect(hits[0]?.content).toBe("vendor entity description");
  });

  it("returns 0 on an empty document list and does not call the embedder", async () => {
    const store = new InMemoryVectorStore({ dimension: D });
    let calls = 0;
    const embedder = createFunctionEmbeddingProvider({
      dimension: D,
      embed: async (text) => {
        calls++;
        return stubEmbed(text);
      },
    });

    const count = await embedAndUpsertDocuments({ store, embedder, documents: [] });
    expect(count).toBe(0);
    expect(calls).toBe(0);
  });

  it("rejects dimension mismatches between embedder and store", async () => {
    const store = new InMemoryVectorStore({ dimension: D });
    const embedder = createFunctionEmbeddingProvider({
      dimension: D + 1,
      embed: async () => [0, 0, 0, 0],
    });

    await expect(
      embedAndUpsertDocuments({
        store,
        embedder,
        documents: [{ id: "x", content: "test" }],
      }),
    ).rejects.toThrow(/dimension/);
  });

  it("rejects when the embedder returns the wrong number of vectors", async () => {
    const store = new InMemoryVectorStore({ dimension: D });
    const embedder = createFunctionEmbeddingProvider({
      dimension: D,
      embed: async (text) => stubEmbed(text),
      embedMany: async (texts) => texts.slice(0, -1).map((t) => stubEmbed(t)),
    });
    await expect(
      embedAndUpsertDocuments({
        store,
        embedder,
        documents: [
          { id: "a", content: "one" },
          { id: "b", content: "two" },
        ],
      }),
    ).rejects.toThrow(/2 documents/);
  });
});
