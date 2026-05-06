/**
 * Tests for the bulk-action client (Spec 16 §3.1).
 *
 * Covers the pure chunking helper plus the fetch-mocked transport:
 *  - single-chunk path (≤ 500 ids)
 *  - multi-chunk path (> 500 ids → multiple requests)
 *  - aggregation under the `partial` strategy
 *  - aggregation under the `all_or_nothing` strategy (rolledBack surfaces)
 *  - HTTP / network errors fold into the `failed` list (never throw)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// Minimal localStorage shim — the api wrappers read `linchkit:token` for auth.
const _store = new Map<string, string>();
if (typeof globalThis.localStorage === "undefined") {
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (key: string) => _store.get(key) ?? null,
      setItem: (key: string, value: string) => _store.set(key, value),
      removeItem: (key: string) => _store.delete(key),
      clear: () => _store.clear(),
      get length() {
        return _store.size;
      },
      key: (index: number) => [..._store.keys()][index] ?? null,
    },
    configurable: true,
  });
}

import type { BatchActionsResult } from "@linchkit/core/types";
import {
  aggregateBatchResults,
  BATCH_CHUNK_SIZE,
  chunkIds,
  executeBatchAction,
} from "../src/lib/batch-actions";

// ── Fetch capture helper ────────────────────────────────────

interface CapturedRequest {
  url: string;
  method: string;
  body: { actions: { name: string; input: Record<string, unknown> }[]; strategy: string };
  headers: Record<string, string>;
}

let captured: CapturedRequest[] = [];
let originalFetch: typeof fetch | undefined;

function installFetch(
  responder: (req: CapturedRequest) => { status: number; body: unknown } | { throw: Error },
) {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req: CapturedRequest = {
      url: typeof input === "string" ? input : (input as URL).toString(),
      method: init?.method ?? "GET",
      body: init?.body
        ? (JSON.parse(init.body as string) as CapturedRequest["body"])
        : ({ actions: [], strategy: "" } as CapturedRequest["body"]),
      headers: (init?.headers as Record<string, string>) ?? {},
    };
    captured.push(req);
    const decision = responder(req);
    if ("throw" in decision) throw decision.throw;
    return new Response(JSON.stringify(decision.body), {
      status: decision.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

beforeEach(() => {
  captured = [];
});

afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
});

// ── chunkIds ────────────────────────────────────────────────

describe("chunkIds", () => {
  test("returns empty array for empty input", () => {
    expect(chunkIds([])).toEqual([]);
  });

  test("returns a single chunk for inputs at or below the cap", () => {
    const ids = Array.from({ length: 500 }, (_, i) => `id-${i}`);
    const chunks = chunkIds(ids);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(500);
  });

  test("splits into 500-sized chunks (default cap mirrors server MAX_BATCH_SIZE)", () => {
    expect(BATCH_CHUNK_SIZE).toBe(500);
    const ids = Array.from({ length: 750 }, (_, i) => `id-${i}`);
    const chunks = chunkIds(ids);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(500);
    expect(chunks[1]).toHaveLength(250);
    expect(chunks[0]?.[0]).toBe("id-0");
    expect(chunks[0]?.[499]).toBe("id-499");
    expect(chunks[1]?.[0]).toBe("id-500");
    expect(chunks[1]?.[249]).toBe("id-749");
  });

  test("respects an explicit smaller chunk size", () => {
    const chunks = chunkIds(["a", "b", "c", "d", "e"], 2);
    expect(chunks).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  });

  test("rejects a non-positive size", () => {
    expect(() => chunkIds(["a"], 0)).toThrow();
    expect(() => chunkIds(["a"], -1)).toThrow();
  });
});

// ── aggregateBatchResults ───────────────────────────────────

function makeResult(overrides: Partial<BatchActionsResult>): BatchActionsResult {
  return {
    success: true,
    parentExecutionId: "parent",
    strategy: "partial",
    succeeded: [],
    failed: [],
    summary: { total: 0, succeeded: 0, failed: 0 },
    ...overrides,
  };
}

describe("aggregateBatchResults", () => {
  test("returns a neutral envelope for an empty result list", () => {
    const merged = aggregateBatchResults([]);
    expect(merged.success).toBe(true);
    expect(merged.summary).toEqual({ total: 0, succeeded: 0, failed: 0 });
    expect(merged.succeeded).toEqual([]);
    expect(merged.failed).toEqual([]);
    expect(merged.rolledBack).toBeUndefined();
  });

  test("concatenates succeeded/failed and sums counts", () => {
    const a = makeResult({
      parentExecutionId: "parent-a",
      succeeded: [{ index: 0, executionId: "x0" }],
      failed: [{ index: 1, error: { code: "E", message: "oops" } }],
      summary: { total: 2, succeeded: 1, failed: 1 },
      success: false,
    });
    const b = makeResult({
      parentExecutionId: "parent-b",
      succeeded: [{ index: 0, executionId: "x1" }],
      summary: { total: 1, succeeded: 1, failed: 0 },
    });
    const merged = aggregateBatchResults([a, b]);
    expect(merged.parentExecutionId).toBe("parent-a");
    expect(merged.succeeded).toHaveLength(2);
    expect(merged.failed).toHaveLength(1);
    expect(merged.summary).toEqual({ total: 3, succeeded: 2, failed: 1 });
    expect(merged.success).toBe(false);
  });

  test("flattens rolledBack only when present", () => {
    const a = makeResult({
      strategy: "all_or_nothing",
      succeeded: [],
      failed: [{ index: 4, error: { code: "E", message: "boom" } }],
      rolledBack: [{ index: 0, executionId: "r0" }],
      summary: { total: 5, succeeded: 0, failed: 1 },
      success: false,
    });
    const b = makeResult({ strategy: "all_or_nothing" });
    const merged = aggregateBatchResults([a, b]);
    expect(merged.rolledBack).toHaveLength(1);
    expect(merged.strategy).toBe("all_or_nothing");
  });
});

// ── executeBatchAction ─────────────────────────────────────

describe("executeBatchAction — single chunk", () => {
  test("posts a single request when ids ≤ cap, defaults to partial strategy", async () => {
    installFetch(() => ({
      status: 200,
      body: makeResult({
        succeeded: [
          { index: 0, executionId: "e0" },
          { index: 1, executionId: "e1" },
        ],
        summary: { total: 2, succeeded: 2, failed: 0 },
      }),
    }));
    const result = await executeBatchAction({
      actionName: "approve_order",
      recordIds: ["a", "b"],
    });
    expect(captured).toHaveLength(1);
    const req = captured[0];
    if (!req) throw new Error("no captured request");
    expect(req.url).toBe("/api/actions/batch");
    expect(req.method).toBe("POST");
    expect(req.body.strategy).toBe("partial");
    expect(req.body.actions).toEqual([
      { name: "approve_order", input: { id: "a" } },
      { name: "approve_order", input: { id: "b" } },
    ]);
    expect(result.summary).toEqual({ total: 2, succeeded: 2, failed: 0 });
  });

  test("merges extraInput into every per-record payload (id wins on collision)", async () => {
    installFetch(() => ({
      status: 200,
      body: makeResult({ summary: { total: 2, succeeded: 2, failed: 0 } }),
    }));
    await executeBatchAction({
      actionName: "approve_order",
      recordIds: ["a", "b"],
      extraInput: { reason: "qa", id: "ignored" },
    });
    expect(captured[0]?.body.actions).toEqual([
      { name: "approve_order", input: { reason: "qa", id: "a" } },
      { name: "approve_order", input: { reason: "qa", id: "b" } },
    ]);
  });
});

describe("executeBatchAction — multi-chunk", () => {
  test("750 ids → 2 sequential requests of 500 + 250, indices re-based", async () => {
    let calls = 0;
    installFetch((req) => {
      calls++;
      const items = req.body.actions;
      // Server-local indices: each item index is its position within the chunk.
      // The first chunk fully succeeds; the second has one failure at local index 10.
      const local = items.map((_, i) => i);
      if (calls === 1) {
        return {
          status: 200,
          body: makeResult({
            succeeded: local.map((i) => ({ index: i, executionId: `e-${i}` })),
            summary: { total: items.length, succeeded: items.length, failed: 0 },
          }),
        };
      }
      // chunk 2 — fail item at local index 10
      const succeeded = local
        .filter((i) => i !== 10)
        .map((i) => ({ index: i, executionId: `e-${i}` }));
      return {
        status: 200,
        body: makeResult({
          success: false,
          succeeded,
          failed: [{ index: 10, error: { code: "E.X", message: "nope" } }],
          summary: { total: items.length, succeeded: succeeded.length, failed: 1 },
        }),
      };
    });

    const ids = Array.from({ length: 750 }, (_, i) => `id-${i}`);
    const result = await executeBatchAction({ actionName: "ship", recordIds: ids });

    expect(captured).toHaveLength(2);
    expect(captured[0]?.body.actions).toHaveLength(500);
    expect(captured[1]?.body.actions).toHaveLength(250);
    // First chunk's first item is id-0; second chunk's first is id-500.
    expect(captured[0]?.body.actions[0]?.input).toEqual({ id: "id-0" });
    expect(captured[1]?.body.actions[0]?.input).toEqual({ id: "id-500" });

    expect(result.summary).toEqual({ total: 750, succeeded: 749, failed: 1 });
    // Failure index is re-based into the absolute selection: local 10 in the
    // second chunk → 500 + 10 = 510.
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.index).toBe(510);
    // Succeeded indices include items from both chunks.
    expect(result.succeeded).toHaveLength(749);
  });
});

describe("executeBatchAction — strategy-specific aggregation", () => {
  test("all_or_nothing: aggregates rolledBack across chunks", async () => {
    installFetch((req) => ({
      status: 200,
      body: makeResult({
        success: false,
        strategy: "all_or_nothing",
        failed: [{ index: 0, error: { code: "E", message: "boom" } }],
        rolledBack: req.body.actions.slice(1).map((_, i) => ({
          index: i + 1,
          executionId: `r-${i}`,
        })),
        summary: { total: req.body.actions.length, succeeded: 0, failed: 1 },
      }),
    }));
    const result = await executeBatchAction({
      actionName: "process_payment",
      recordIds: ["a", "b", "c"],
      strategy: "all_or_nothing",
    });
    expect(captured[0]?.body.strategy).toBe("all_or_nothing");
    expect(result.strategy).toBe("all_or_nothing");
    expect(result.rolledBack).toHaveLength(2);
    expect(result.failed).toHaveLength(1);
    expect(result.success).toBe(false);
  });

  test("partial: per-item failures stay isolated; aggregate flags success=false", async () => {
    installFetch(() => ({
      status: 200,
      body: makeResult({
        success: false,
        strategy: "partial",
        succeeded: [{ index: 0, executionId: "ok" }],
        failed: [{ index: 1, error: { code: "VAL.BAD", message: "bad input" } }],
        summary: { total: 2, succeeded: 1, failed: 1 },
      }),
    }));
    const result = await executeBatchAction({
      actionName: "approve_order",
      recordIds: ["a", "b"],
      // strategy intentionally omitted to verify default
    });
    expect(captured[0]?.body.strategy).toBe("partial");
    expect(result.success).toBe(false);
    expect(result.succeeded).toHaveLength(1);
    expect(result.failed[0]?.error.code).toBe("VAL.BAD");
  });
});

describe("executeBatchAction — error responses fold into failed", () => {
  test("HTTP 500 produces a synthetic failed entry per item, never throws", async () => {
    installFetch(() => ({
      status: 500,
      body: { error: { code: "SYS", message: "server exploded" } },
    }));
    const ids = ["a", "b", "c"];
    const result = await executeBatchAction({ actionName: "noop", recordIds: ids });
    expect(result.failed).toHaveLength(3);
    expect(result.failed[0]?.error.code).toBe("BATCH.TRANSPORT");
    expect(result.failed[0]?.error.message).toBe("server exploded");
    expect(result.summary).toEqual({ total: 3, succeeded: 0, failed: 3 });
  });

  test("network error (fetch throws) folds into failed, never throws", async () => {
    installFetch(() => ({ throw: new Error("connection refused") }));
    const result = await executeBatchAction({
      actionName: "noop",
      recordIds: ["a", "b"],
    });
    expect(result.failed).toHaveLength(2);
    expect(result.failed[0]?.error.code).toBe("BATCH.TRANSPORT");
    expect(result.failed[0]?.error.message).toBe("connection refused");
  });

  test("HTTP 4xx without JSON body falls back to status-derived reason", async () => {
    installFetch(() => ({ status: 403, body: "forbidden" as unknown }));
    const result = await executeBatchAction({
      actionName: "noop",
      recordIds: ["a"],
    });
    // Body parses as a JSON string; no `.error.message` → fallback used.
    expect(result.failed[0]?.error.message).toBe("Batch request failed (403)");
  });
});

describe("executeBatchAction — short-circuit on failure", () => {
  test("all_or_nothing: stops after a chunk fails — no further requests", async () => {
    let chunkCount = 0;
    installFetch((req) => {
      chunkCount++;
      if (chunkCount === 1) {
        return {
          status: 200,
          body: makeResult({
            success: false,
            strategy: "all_or_nothing",
            failed: [{ index: 0, error: { code: "VAL.BAD", message: "rejected" } }],
            rolledBack: req.body.actions.slice(1).map((_, i) => ({
              index: i + 1,
              executionId: `r-${i}`,
            })),
            summary: { total: req.body.actions.length, succeeded: 0, failed: 1 },
          }),
        };
      }
      // We must never get here — fail loudly if a second chunk fires.
      throw new Error("second chunk should have been skipped");
    });
    const ids = Array.from({ length: 750 }, (_, i) => `id-${i}`);
    const result = await executeBatchAction({
      actionName: "process_payment",
      recordIds: ids,
      strategy: "all_or_nothing",
    });
    expect(chunkCount).toBe(1);
    expect(result.success).toBe(false);
    // Only the first chunk's failures/rollbacks should be present — no
    // synthetic transport entries for the skipped chunk.
    expect(result.failed.every((f) => f.error.code !== "BATCH.TRANSPORT")).toBe(true);
  });

  test("partial: a chunk failure does NOT stop subsequent chunks", async () => {
    let chunkCount = 0;
    installFetch(() => {
      chunkCount++;
      return {
        status: 200,
        body: makeResult({
          success: chunkCount > 1,
          strategy: "partial",
          failed:
            chunkCount === 1 ? [{ index: 0, error: { code: "VAL.BAD", message: "rejected" } }] : [],
          summary: {
            total: 1,
            succeeded: chunkCount > 1 ? 1 : 0,
            failed: chunkCount === 1 ? 1 : 0,
          },
        }),
      };
    });
    const ids = Array.from({ length: 750 }, (_, i) => `id-${i}`);
    const result = await executeBatchAction({
      actionName: "approve_order",
      recordIds: ids,
      strategy: "partial",
    });
    expect(chunkCount).toBe(2);
    expect(result.failed).toHaveLength(1);
  });

  test("transport error stops further chunks regardless of strategy", async () => {
    let chunkCount = 0;
    installFetch(() => {
      chunkCount++;
      if (chunkCount === 1) return { throw: new Error("connection refused") };
      throw new Error("second chunk should have been skipped after transport error");
    });
    const ids = Array.from({ length: 750 }, (_, i) => `id-${i}`);
    const result = await executeBatchAction({
      actionName: "approve_order",
      recordIds: ids,
      strategy: "partial",
    });
    expect(chunkCount).toBe(1);
    expect(result.failed[0]?.error.code).toBe("BATCH.TRANSPORT");
  });
});
