/**
 * vector-math tests — covers the cosine-similarity scoring contract that
 * both the pgvector and in-memory backends honour, and the order-
 * independent deep-equality helper that drives `matchesFilter`.
 */

import { describe, expect, it } from "bun:test";
import { cosineSimilarity, deepEqual, matchesFilter } from "../src/vector-math";

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors after rescale", () => {
    // Raw cos = 1 → rescaled to (1 + 1) / 2 = 1.0
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1.0);
  });

  it("returns 0 for opposite vectors after rescale", () => {
    // Raw cos = -1 → rescaled to 0.0
    expect(cosineSimilarity([1, 0, 0], [-1, 0, 0])).toBeCloseTo(0.0);
  });

  it("returns 0.5 for orthogonal vectors after rescale", () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0.5);
  });

  it("returns 0 when either vector is zero", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 0, 0])).toBe(0);
  });

  it("throws on length mismatch", () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow(/length mismatch/);
  });
});

describe("deepEqual", () => {
  it("compares primitives via Object.is", () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual("a", "a")).toBe(true);
    expect(deepEqual(Number.NaN, Number.NaN)).toBe(true);
    expect(deepEqual(null, null)).toBe(true);
    expect(deepEqual(undefined, undefined)).toBe(true);
    expect(deepEqual(1, "1")).toBe(false);
    expect(deepEqual(null, undefined)).toBe(false);
  });

  it("is order-independent for object keys (vs JSON.stringify)", () => {
    const a = { x: 1, y: 2 };
    const b = { y: 2, x: 1 };
    // JSON.stringify would return distinct strings here on some engines —
    // the helper must report equal regardless of insertion order.
    expect(deepEqual(a, b)).toBe(true);
  });

  it("recurses into nested objects and arrays", () => {
    const a = { nested: { arr: [1, { k: "v" }, 3] } };
    const b = { nested: { arr: [1, { k: "v" }, 3] } };
    expect(deepEqual(a, b)).toBe(true);

    const c = { nested: { arr: [1, { k: "different" }, 3] } };
    expect(deepEqual(a, c)).toBe(false);
  });

  it("treats arrays of different length as unequal", () => {
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
  });

  it("treats arrays and objects as distinct types", () => {
    expect(deepEqual([1, 2], { 0: 1, 1: 2, length: 2 })).toBe(false);
  });

  it("rejects when key sets differ", () => {
    expect(deepEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false);
    expect(deepEqual({ a: 1 }, { b: 1 })).toBe(false);
  });
});

describe("matchesFilter", () => {
  it("passes when every filter key matches the metadata", () => {
    expect(matchesFilter({ tenant_id: "t1", entity: "order" }, { tenant_id: "t1" })).toBe(true);
  });

  it("rejects when a required key is missing", () => {
    expect(matchesFilter({ tenant_id: "t1" }, { entity: "order" })).toBe(false);
  });

  it("rejects when a key's value differs", () => {
    expect(matchesFilter({ tenant_id: "t1" }, { tenant_id: "t2" })).toBe(false);
  });

  it("matches nested objects regardless of key order", () => {
    const metadata = { ctx: { a: 1, b: 2 } };
    const filter = { ctx: { b: 2, a: 1 } };
    expect(matchesFilter(metadata, filter)).toBe(true);
  });
});
