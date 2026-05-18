/**
 * PgVectorStore unit tests — use a hand-rolled fake Drizzle DB so we can
 * exercise the SQL plumbing without standing up PostgreSQL. The fake
 * captures every call so assertions can inspect chunking, conflict
 * targets, dimension validation, and the score-rescaling formula.
 */

import { describe, expect, it } from "bun:test";
import { createPgVectorStore, PgVectorStore } from "../src/pgvector-store";

interface Recorded {
  insertCalls: Array<{ rows: unknown[]; conflict: Record<string, unknown> | undefined }>;
  selectCalls: number;
  deleteCalls: number;
  lastSelectLimit: number | undefined;
}

interface FakeDb {
  record: Recorded;
  insert: (...args: unknown[]) => unknown;
  select: (...args: unknown[]) => unknown;
  delete: (...args: unknown[]) => unknown;
}

function makeFakeDb(options: {
  rowsToReturn?: Array<{
    id: string;
    namespace: string;
    metadata: Record<string, unknown> | null;
    content: string | null;
    score: number | string | null;
  }>;
  deleteReturning?: Array<{ id: string }>;
}): FakeDb {
  const record: Recorded = {
    insertCalls: [],
    selectCalls: 0,
    deleteCalls: 0,
    lastSelectLimit: undefined,
  };

  const insertChain = () => {
    let capturedRows: unknown[] = [];
    return {
      values: (rows: unknown) => {
        capturedRows = Array.isArray(rows) ? rows : [rows];
        return {
          onConflictDoUpdate: async (conflict: Record<string, unknown>) => {
            record.insertCalls.push({ rows: capturedRows, conflict });
          },
        };
      },
    };
  };

  const selectChain = () => {
    return {
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async (n: number) => {
              record.selectCalls++;
              record.lastSelectLimit = n;
              return options.rowsToReturn ?? [];
            },
          }),
        }),
      }),
    };
  };

  const deleteChain = () => {
    return {
      where: () => ({
        returning: async () => {
          record.deleteCalls++;
          return options.deleteReturning ?? [];
        },
      }),
    };
  };

  return {
    record,
    insert: insertChain,
    select: selectChain,
    delete: deleteChain,
  };
}

const D = 4;

function vec(...values: number[]): number[] {
  if (values.length !== D) {
    throw new Error(`vec(): expected ${D} components, got ${values.length}`);
  }
  return values;
}

describe("PgVectorStore — construction", () => {
  it("rejects when db is missing", () => {
    expect(() => new PgVectorStore({ db: undefined, dimension: D })).toThrow(/required/);
  });

  it("rejects a non-Drizzle-shaped db", () => {
    expect(() => new PgVectorStore({ db: {}, dimension: D })).toThrow(/insert\/select\/delete/);
  });

  it("rejects a non-positive dimension", () => {
    const db = makeFakeDb({});
    expect(() => new PgVectorStore({ db, dimension: 0 })).toThrow(/positive integer/);
    expect(() => new PgVectorStore({ db, dimension: 1.5 })).toThrow(/positive integer/);
  });

  it("rejects a non-positive batch chunk size", () => {
    const db = makeFakeDb({});
    expect(() => new PgVectorStore({ db, dimension: D, batchChunkSize: 0 })).toThrow(
      /batchChunkSize/,
    );
  });

  it("createPgVectorStore factory mirrors the constructor", () => {
    const db = makeFakeDb({});
    const store = createPgVectorStore({ db, dimension: D });
    expect(store).toBeInstanceOf(PgVectorStore);
    expect(store.dimension).toBe(D);
  });
});

describe("PgVectorStore.upsert", () => {
  it("rejects mismatched dimension", async () => {
    const db = makeFakeDb({});
    const store = new PgVectorStore({ db, dimension: D });
    await expect(store.upsert({ id: "x", vector: [1, 0, 0], metadata: {} })).rejects.toThrow(
      /expected 4/,
    );
  });

  it("rejects non-finite vector components (NaN / Infinity)", async () => {
    const db = makeFakeDb({});
    const store = new PgVectorStore({ db, dimension: D });
    await expect(
      store.upsert({ id: "nan", vector: vec(Number.NaN, 0, 0, 0), metadata: {} }),
    ).rejects.toThrow(/non-finite/);
    await expect(
      store.upsert({ id: "inf", vector: vec(Number.POSITIVE_INFINITY, 0, 0, 0), metadata: {} }),
    ).rejects.toThrow(/non-finite/);
  });

  it("writes a single row with the supplied namespace", async () => {
    const db = makeFakeDb({});
    const store = new PgVectorStore({ db, dimension: D });
    await store.upsert({
      id: "a",
      vector: vec(1, 0, 0, 0),
      metadata: { tag: "demo" },
      namespace: "meta_model",
    });
    expect(db.record.insertCalls).toHaveLength(1);
    const call = db.record.insertCalls[0];
    if (!call) throw new Error("missing insert call");
    expect(call.rows).toHaveLength(1);
    const row = call.rows[0] as { id: string; namespace: string };
    expect(row.id).toBe("a");
    expect(row.namespace).toBe("meta_model");
  });
});

describe("PgVectorStore.batchUpsert", () => {
  it("is a no-op when items is empty", async () => {
    const db = makeFakeDb({});
    const store = new PgVectorStore({ db, dimension: D });
    await store.batchUpsert([]);
    expect(db.record.insertCalls).toHaveLength(0);
  });

  it("chunks oversize input into multiple INSERT statements", async () => {
    const db = makeFakeDb({});
    const store = new PgVectorStore({ db, dimension: D, batchChunkSize: 3 });
    const items = Array.from({ length: 7 }, (_, i) => ({
      id: `r${i}`,
      vector: vec(1, 0, 0, 0),
      metadata: { i },
    }));
    await store.batchUpsert(items);
    // 7 items, chunk size 3 → 3 + 3 + 1
    expect(db.record.insertCalls).toHaveLength(3);
    expect(db.record.insertCalls[0]?.rows).toHaveLength(3);
    expect(db.record.insertCalls[1]?.rows).toHaveLength(3);
    expect(db.record.insertCalls[2]?.rows).toHaveLength(1);
  });

  it("validates every item before issuing any INSERT", async () => {
    const db = makeFakeDb({});
    const store = new PgVectorStore({ db, dimension: D });
    await expect(
      store.batchUpsert([
        { id: "ok", vector: vec(1, 0, 0, 0), metadata: {} },
        { id: "bad", vector: [1, 0, 0], metadata: {} },
      ]),
    ).rejects.toThrow(/expected 4/);
    expect(db.record.insertCalls).toHaveLength(0);
  });
});

describe("PgVectorStore.search", () => {
  it("rejects non-finite query components", async () => {
    const db = makeFakeDb({});
    const store = new PgVectorStore({ db, dimension: D });
    await expect(store.search(vec(Number.NaN, 0, 0, 0))).rejects.toThrow(/non-finite/);
  });

  it("clamps topK to [1, 200]", async () => {
    const db = makeFakeDb({});
    const store = new PgVectorStore({ db, dimension: D });
    await store.search(vec(1, 0, 0, 0), { topK: 9999 });
    expect(db.record.lastSelectLimit).toBe(200);
    await store.search(vec(1, 0, 0, 0), { topK: 0 });
    expect(db.record.lastSelectLimit).toBe(10);
  });

  it("returns rows with score coerced to a finite number", async () => {
    const db = makeFakeDb({
      rowsToReturn: [
        { id: "a", namespace: "default", metadata: { x: 1 }, content: "alpha", score: 0.91 },
        { id: "b", namespace: "default", metadata: null, content: null, score: "0.42" },
        { id: "c", namespace: "default", metadata: {}, content: null, score: null },
      ],
    });
    const store = new PgVectorStore({ db, dimension: D });
    const hits = await store.search(vec(1, 0, 0, 0));
    expect(hits).toHaveLength(3);
    expect(hits[0]).toEqual({
      id: "a",
      namespace: "default",
      score: 0.91,
      metadata: { x: 1 },
      content: "alpha",
    });
    expect(hits[1]?.score).toBeCloseTo(0.42);
    expect(hits[1]?.metadata).toEqual({});
    expect(hits[2]?.score).toBe(0);
  });

  it("drops rows below minScore", async () => {
    const db = makeFakeDb({
      rowsToReturn: [
        { id: "high", namespace: "default", metadata: {}, content: null, score: 0.95 },
        { id: "low", namespace: "default", metadata: {}, content: null, score: 0.1 },
      ],
    });
    const store = new PgVectorStore({ db, dimension: D });
    const hits = await store.search(vec(1, 0, 0, 0), { minScore: 0.5 });
    expect(hits.map((h) => h.id)).toEqual(["high"]);
  });
});

describe("PgVectorStore.delete / clearNamespace", () => {
  it("delete returns true when at least one row matched", async () => {
    const db = makeFakeDb({ deleteReturning: [{ id: "x" }] });
    const store = new PgVectorStore({ db, dimension: D });
    expect(await store.delete("x")).toBe(true);
  });

  it("delete returns false when no row matched", async () => {
    const db = makeFakeDb({ deleteReturning: [] });
    const store = new PgVectorStore({ db, dimension: D });
    expect(await store.delete("missing")).toBe(false);
  });

  it("clearNamespace returns the number of rows removed", async () => {
    const db = makeFakeDb({ deleteReturning: [{ id: "a" }, { id: "b" }, { id: "c" }] });
    const store = new PgVectorStore({ db, dimension: D });
    expect(await store.clearNamespace("ns")).toBe(3);
  });
});
