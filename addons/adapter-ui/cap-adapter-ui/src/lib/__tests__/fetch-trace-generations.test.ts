/**
 * fetchTraceGenerations wire-mapping tests.
 *
 * Pure logic-only (no jsdom): the `fetch` seam is replaced by an injected stub
 * (dependency injection — never a global fetch mock), and the discriminated
 * `AITraceGenerationsResult` arms are asserted against the
 * `GET /api/ai/traces/:id/generations` envelope. These cover the same states
 * the detail panel renders: populated cards (`ok` + generations), the empty
 * state (`ok` + none), and the permission-denied state (`denied`).
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

const { fetchTraceGenerations } = await import("../ai-traces-client");
type AIGeneration = import("../ai-traces-client").AIGeneration;

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

const SAMPLE_GENERATION: AIGeneration = {
  id: "gen-1",
  traceId: "trace-abcdef123456",
  model: "glm-4.6",
  provider: "zhipu",
  messages: [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Fill the form for [REDACTED]." },
  ],
  completion: '{"name":"[REDACTED]"}',
  inputTokens: 120,
  outputTokens: 45,
  cost: 0.000026,
  latencyMs: 420,
  status: "ok",
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_000_420,
};

// ── ok: populated ───────────────────────────────────────────

describe("fetchTraceGenerations", () => {
  test("maps a successful envelope to { kind: 'ok' } with generations", async () => {
    const result = await fetchTraceGenerations({
      traceId: "trace-abcdef123456",
      fetchImpl: stubFetch({
        success: true,
        data: { generations: [SAMPLE_GENERATION], count: 1 },
      }),
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.count).toBe(1);
    expect(result.generations).toHaveLength(1);
    expect(result.generations[0]?.id).toBe("gen-1");
    expect(result.generations[0]?.messages).toHaveLength(2);
  });

  // ── ok: empty ─────────────────────────────────────────────

  test("maps an empty data envelope to { kind: 'ok' } with no generations", async () => {
    const result = await fetchTraceGenerations({
      traceId: "trace-empty",
      fetchImpl: stubFetch({ success: true, data: { generations: [], count: 0 } }),
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.generations).toHaveLength(0);
    expect(result.count).toBe(0);
  });

  // ── denied ────────────────────────────────────────────────

  test("maps a 403 AUTHZ_DENIED envelope to { kind: 'denied' }", async () => {
    const result = await fetchTraceGenerations({
      traceId: "trace-denied",
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
    const result = await fetchTraceGenerations({
      traceId: "trace-blocked",
      fetchImpl: stubFetch({
        success: false,
        error: { code: "AI.READ_TRACES.BLOCKED", message: "blocked" },
      }),
    });
    expect(result.kind).toBe("denied");
  });

  // ── error ─────────────────────────────────────────────────

  test("maps a non-authz failure to { kind: 'error' }", async () => {
    const result = await fetchTraceGenerations({
      traceId: "trace-error",
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
    const result = await fetchTraceGenerations({
      traceId: "trace-offline",
      fetchImpl: throwingFetch,
    });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("expected error");
    expect(result.message).toBe("network down");
  });

  // ── URL construction (contract) ───────────────────────────

  test("builds the request URL with the encoded trace id and limit param", async () => {
    let captured = "";
    const capturingFetch = (async (url: string) => {
      captured = url;
      return new Response(JSON.stringify({ success: true, data: { generations: [], count: 0 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await fetchTraceGenerations({ traceId: "trace-123", limit: 100, fetchImpl: capturingFetch });
    expect(captured).toBe("/api/ai/traces/trace-123/generations?limit=100");

    await fetchTraceGenerations({ traceId: "trace-123", fetchImpl: capturingFetch });
    expect(captured).toBe("/api/ai/traces/trace-123/generations");

    // Path-unsafe ids must be percent-encoded, never spliced raw into the path.
    await fetchTraceGenerations({ traceId: "trace/../x?y", fetchImpl: capturingFetch });
    expect(captured).toBe("/api/ai/traces/trace%2F..%2Fx%3Fy/generations");
  });

  // ── denied: non-JSON 403 body (proxy / gateway) ───────────

  test("maps a 403 with a non-JSON body to { kind: 'denied' }", async () => {
    const nonJsonFetch = (async () =>
      new Response("Forbidden", {
        status: 403,
        headers: { "Content-Type": "text/plain" },
      })) as unknown as typeof fetch;
    const result = await fetchTraceGenerations({
      traceId: "trace-proxy",
      fetchImpl: nonJsonFetch,
    });
    expect(result.kind).toBe("denied");
  });
});
