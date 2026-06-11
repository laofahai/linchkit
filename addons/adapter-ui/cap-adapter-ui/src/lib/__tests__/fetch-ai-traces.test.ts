/**
 * fetchAITraces wire-mapping tests.
 *
 * Pure logic-only (no jsdom): the `fetch` seam is replaced by an injected stub
 * (dependency injection — never a global fetch mock), and the discriminated
 * `AITracesResult` arms are asserted against the `GET /api/ai/traces` envelope.
 * These cover the same three states the page renders: a populated table
 * (`ok` + traces), the empty state (`ok` + no traces), and the
 * permission-denied state (`denied`).
 */

import { describe, expect, test } from "bun:test";

// `api.ts` reads the auth token from `localStorage` via `getAuthHeaders()`.
// Under the pure-logic (no-jsdom) test runner that global is absent, so install
// a minimal in-memory stub BEFORE importing the module under test. This is a
// browser-API shim, not a network/fetch mock — the fetch seam is still injected.
if (typeof globalThis.localStorage === "undefined") {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, String(value)),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
      key: (index: number) => Array.from(store.keys())[index] ?? null,
      get length() {
        return store.size;
      },
    },
  });
}

const { fetchAITraces } = await import("../api");
type AITrace = import("../api").AITrace;

// ── Helpers ─────────────────────────────────────────────────

/** Build a stub `fetch` returning the given JSON body + HTTP status. */
function stubFetch(body: unknown, init: { status?: number } = {}): typeof fetch {
  const status = init.status ?? 200;
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
}

const SAMPLE_TRACE: AITrace = {
  traceId: "trace-abcdef123456",
  name: "generate_object",
  scenario: "auto_fill",
  origin: "production",
  status: "ok",
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_000_420,
  inputTokens: 120,
  outputTokens: 45,
  cost: 0.000026,
};

// ── ok: populated ───────────────────────────────────────────

describe("fetchAITraces", () => {
  test("maps a successful envelope to { kind: 'ok' } with traces", async () => {
    const result = await fetchAITraces({
      fetchImpl: stubFetch({ success: true, data: { traces: [SAMPLE_TRACE], count: 1 } }),
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.count).toBe(1);
    expect(result.traces).toHaveLength(1);
    expect(result.traces[0]?.traceId).toBe("trace-abcdef123456");
  });

  // ── ok: empty ─────────────────────────────────────────────

  test("maps an empty data envelope to { kind: 'ok' } with no traces", async () => {
    const result = await fetchAITraces({
      fetchImpl: stubFetch({ success: true, data: { traces: [], count: 0 } }),
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.traces).toHaveLength(0);
    expect(result.count).toBe(0);
  });

  // ── denied ────────────────────────────────────────────────

  test("maps a 403 AUTHZ_DENIED envelope to { kind: 'denied' }", async () => {
    const result = await fetchAITraces({
      fetchImpl: stubFetch(
        { success: false, error: { code: "AUTHZ_DENIED", message: "Access denied" } },
        { status: 403 },
      ),
    });
    expect(result.kind).toBe("denied");
    if (result.kind !== "denied") throw new Error("expected denied");
    expect(result.message).toBe("Access denied");
  });

  test("maps an AI.READ_TRACES.BLOCKED code to { kind: 'denied' } regardless of status", async () => {
    const result = await fetchAITraces({
      fetchImpl: stubFetch({
        success: false,
        error: { code: "AI.READ_TRACES.BLOCKED", message: "blocked" },
      }),
    });
    expect(result.kind).toBe("denied");
  });

  // ── error ─────────────────────────────────────────────────

  test("maps a non-authz failure to { kind: 'error' }", async () => {
    const result = await fetchAITraces({
      fetchImpl: stubFetch(
        { success: false, error: { code: "INTERNAL", message: "boom" } },
        { status: 500 },
      ),
    });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("expected error");
    expect(result.message).toBe("boom");
  });

  test("maps a transport throw to { kind: 'error' }", async () => {
    const throwingFetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const result = await fetchAITraces({ fetchImpl: throwingFetch });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("expected error");
    expect(result.message).toBe("network down");
  });
});
