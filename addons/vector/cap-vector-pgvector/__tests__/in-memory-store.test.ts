/**
 * InMemoryVectorStore tests — verifies the upsert / search / delete
 * semantics that downstream RAG helpers and the pgvector store
 * implementation share. Pure brute-force KNN over deterministic vectors,
 * no AI provider or PostgreSQL required.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { InMemoryVectorStore } from "../src/in-memory-store";

const D = 4;

function vec(...values: number[]): number[] {
  if (values.length !== D) {
    throw new Error(`vec(): expected ${D} components, got ${values.length}`);
  }
  return values;
}

describe("InMemoryVectorStore", () => {
  let store: InMemoryVectorStore;

  beforeEach(() => {
    store = new InMemoryVectorStore({ dimension: D });
  });

  it("rejects vectors whose length does not match the configured dimension", async () => {
    await expect(store.upsert({ id: "x", vector: [1, 0, 0], metadata: {} })).rejects.toThrow(
      /expected 4/,
    );
  });

  it("returns the nearest vector first by cosine similarity", async () => {
    await store.upsert({ id: "a", vector: vec(1, 0, 0, 0), metadata: { label: "a" } });
    await store.upsert({ id: "b", vector: vec(0, 1, 0, 0), metadata: { label: "b" } });
    await store.upsert({ id: "c", vector: vec(0, 0, 1, 0), metadata: { label: "c" } });

    const hits = await store.search(vec(0.9, 0.1, 0, 0));
    expect(hits.length).toBe(3);
    expect(hits[0]?.id).toBe("a");
    // Scores are in [0, 1] after rescaling; nearest should be ≥ runner-up.
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 0);
  });

  it("respects topK", async () => {
    for (let i = 0; i < 5; i++) {
      await store.upsert({ id: `r${i}`, vector: vec(i + 1, 0, 0, 0), metadata: {} });
    }
    const hits = await store.search(vec(1, 0, 0, 0), { topK: 2 });
    expect(hits).toHaveLength(2);
  });

  it("isolates results by namespace", async () => {
    await store.upsert({
      id: "x",
      vector: vec(1, 0, 0, 0),
      metadata: { ns: "meta" },
      namespace: "meta_model",
    });
    await store.upsert({
      id: "x",
      vector: vec(1, 0, 0, 0),
      metadata: { ns: "data" },
      namespace: "data:order",
    });

    const meta = await store.search(vec(1, 0, 0, 0), { namespace: "meta_model" });
    expect(meta).toHaveLength(1);
    expect(meta[0]?.metadata.ns).toBe("meta");

    const data = await store.search(vec(1, 0, 0, 0), { namespace: "data:order" });
    expect(data).toHaveLength(1);
    expect(data[0]?.metadata.ns).toBe("data");

    // Default namespace bucket is empty
    const def = await store.search(vec(1, 0, 0, 0));
    expect(def).toHaveLength(0);
  });

  it("applies JSONB-style equality filters", async () => {
    await store.upsert({
      id: "1",
      vector: vec(1, 0, 0, 0),
      metadata: { tenant_id: "t1", entity: "order" },
    });
    await store.upsert({
      id: "2",
      vector: vec(1, 0, 0, 0),
      metadata: { tenant_id: "t2", entity: "order" },
    });
    await store.upsert({
      id: "3",
      vector: vec(1, 0, 0, 0),
      metadata: { tenant_id: "t1", entity: "vendor" },
    });

    const tenantOnly = await store.search(vec(1, 0, 0, 0), { filter: { tenant_id: "t1" } });
    expect(tenantOnly.map((h) => h.id).sort()).toEqual(["1", "3"]);

    const both = await store.search(vec(1, 0, 0, 0), {
      filter: { tenant_id: "t1", entity: "order" },
    });
    expect(both).toHaveLength(1);
    expect(both[0]?.id).toBe("1");
  });

  it("drops results below minScore", async () => {
    await store.upsert({ id: "near", vector: vec(1, 0, 0, 0), metadata: {} });
    await store.upsert({ id: "far", vector: vec(-1, 0, 0, 0), metadata: {} });

    const hits = await store.search(vec(1, 0, 0, 0), { minScore: 0.9 });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.id).toBe("near");
  });

  it("batchUpsert writes every row", async () => {
    await store.batchUpsert([
      { id: "a", vector: vec(1, 0, 0, 0), metadata: {} },
      { id: "b", vector: vec(0, 1, 0, 0), metadata: {} },
      { id: "c", vector: vec(0, 0, 1, 0), metadata: {} },
    ]);
    expect(store.size()).toBe(3);
  });

  it("upsert replaces an existing row under the same (id, namespace)", async () => {
    await store.upsert({ id: "x", vector: vec(1, 0, 0, 0), metadata: { v: 1 } });
    await store.upsert({ id: "x", vector: vec(0, 1, 0, 0), metadata: { v: 2 } });
    expect(store.size()).toBe(1);

    const hits = await store.search(vec(0, 1, 0, 0));
    expect(hits[0]?.id).toBe("x");
    expect(hits[0]?.metadata.v).toBe(2);
  });

  it("delete removes one row and is scoped to a namespace", async () => {
    await store.upsert({ id: "x", vector: vec(1, 0, 0, 0), metadata: {}, namespace: "a" });
    await store.upsert({ id: "x", vector: vec(1, 0, 0, 0), metadata: {}, namespace: "b" });

    expect(await store.delete("x", { namespace: "a" })).toBe(true);
    expect(await store.delete("x", { namespace: "a" })).toBe(false);
    expect(store.size()).toBe(1);
  });

  it("clearNamespace drops every row under the namespace and returns the count", async () => {
    await store.upsert({ id: "x", vector: vec(1, 0, 0, 0), metadata: {}, namespace: "ns" });
    await store.upsert({ id: "y", vector: vec(0, 1, 0, 0), metadata: {}, namespace: "ns" });
    await store.upsert({ id: "z", vector: vec(0, 0, 1, 0), metadata: {}, namespace: "other" });

    const dropped = await store.clearNamespace("ns");
    expect(dropped).toBe(2);
    expect(store.size()).toBe(1);
  });
});
