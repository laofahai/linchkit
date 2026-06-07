/**
 * Tests for the `runEvolutionCycle` + `graduateProposal` clients.
 *
 * Both clients map the server's JSON envelope (200 happy path + 4xx/5xx/501/503
 * + transport error / invalid JSON) onto a discriminated result the UI renders.
 *
 * We inject a stub `fetch` via the `fetchImpl` option so the assertions never
 * rely on a GLOBAL fetch mock — a global stub would leak across the batched
 * suite and clobber other tests' network calls. Each case builds its own
 * `Response` and asserts the mapping. Mirrors `resolve-schema-intent.test.ts`.
 */

import { beforeEach, describe, expect, test } from "bun:test";

// Minimal localStorage shim — the clients call getAuthHeaders() which reads
// localStorage. The bun test runner has no DOM; mirror resolve-schema-intent.test.ts.
const store = new Map<string, string>();
if (typeof globalThis.localStorage === "undefined") {
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
      get length() {
        return store.size;
      },
      key: (index: number) => [...store.keys()][index] ?? null,
    },
    configurable: true,
  });
}

import { graduateProposal, runEvolutionCycle } from "../src/lib/proposal-api";

/** Build a JSON Response with a given status + body. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A `fetch` stub that always returns the given response and records the call. */
function stubFetch(response: Response | (() => Response | Promise<Response>)): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return typeof response === "function" ? await response() : response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

// ── runEvolutionCycle ─────────────────────────────────────

describe("runEvolutionCycle client", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("POSTs to the run-cycle endpoint", async () => {
    const { fetchImpl, calls } = stubFetch(
      jsonResponse(200, {
        success: true,
        data: { created: 0, deduped: 0, total: 0, createdIds: [] },
      }),
    );
    await runEvolutionCycle({ fetchImpl });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/evolution/run-cycle");
    expect(calls[0]?.init?.method).toBe("POST");
  });

  test("maps 200 to a ran result with counts + ids", async () => {
    const { fetchImpl } = stubFetch(
      jsonResponse(200, {
        success: true,
        data: { created: 2, deduped: 1, total: 3, createdIds: ["p_1", "p_2"] },
      }),
    );
    const result = await runEvolutionCycle({ fetchImpl });
    expect(result.kind).toBe("ran");
    if (result.kind !== "ran") return;
    expect(result.created).toBe(2);
    expect(result.deduped).toBe(1);
    expect(result.total).toBe(3);
    expect(result.createdIds).toEqual(["p_1", "p_2"]);
  });

  test("defaults missing data fields on a 200 ran result", async () => {
    const { fetchImpl } = stubFetch(jsonResponse(200, { success: true }));
    const result = await runEvolutionCycle({ fetchImpl });
    expect(result.kind).toBe("ran");
    if (result.kind !== "ran") return;
    expect(result.created).toBe(0);
    expect(result.deduped).toBe(0);
    expect(result.total).toBe(0);
    expect(result.createdIds).toEqual([]);
  });

  test("maps 501 (runtime not configured) to unavailable", async () => {
    const { fetchImpl } = stubFetch(
      jsonResponse(501, {
        success: false,
        error: { code: "NOT_IMPLEMENTED", message: "Evolution runtime not configured." },
      }),
    );
    const result = await runEvolutionCycle({ fetchImpl });
    expect(result.kind).toBe("unavailable");
    if (result.kind !== "unavailable") return;
    expect(result.message).toBe("Evolution runtime not configured.");
  });

  test("maps 503 (command layer not configured) to unavailable", async () => {
    const { fetchImpl } = stubFetch(
      jsonResponse(503, {
        success: false,
        error: { code: "SERVICE.UNAVAILABLE", message: "Command layer not configured." },
      }),
    );
    const result = await runEvolutionCycle({ fetchImpl });
    expect(result.kind).toBe("unavailable");
    if (result.kind !== "unavailable") return;
    expect(result.message).toBe("Command layer not configured.");
  });

  test("maps 401 to denied", async () => {
    const { fetchImpl } = stubFetch(
      jsonResponse(401, {
        success: false,
        error: { code: "AUTHZ_DENIED", message: "Access denied" },
      }),
    );
    const result = await runEvolutionCycle({ fetchImpl });
    expect(result.kind).toBe("denied");
  });

  test("maps 403 to denied", async () => {
    const { fetchImpl } = stubFetch(
      jsonResponse(403, {
        success: false,
        error: { code: "AUTHZ_DENIED", message: "Access denied" },
      }),
    );
    const result = await runEvolutionCycle({ fetchImpl });
    expect(result.kind).toBe("denied");
  });

  test("maps another non-2xx to error with the message", async () => {
    const { fetchImpl } = stubFetch(
      jsonResponse(500, { success: false, error: { message: "boom" } }),
    );
    const result = await runEvolutionCycle({ fetchImpl });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toBe("boom");
  });

  test("maps a transport throw to error", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const result = await runEvolutionCycle({ fetchImpl });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toBe("network down");
  });

  test("maps invalid JSON on a 200 to error", async () => {
    const { fetchImpl } = stubFetch(new Response("not json", { status: 200 }));
    const result = await runEvolutionCycle({ fetchImpl });
    expect(result.kind).toBe("error");
  });
});

// ── graduateProposal ──────────────────────────────────────

describe("graduateProposal client", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("POSTs to the graduate endpoint with the encoded id", async () => {
    const { fetchImpl, calls } = stubFetch(
      jsonResponse(200, {
        success: true,
        data: { prUrl: "x", branch: "y", commitSha: "z", committed: true },
      }),
    );
    await graduateProposal("prop 1/odd", { fetchImpl });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/proposals/prop%201%2Fodd/graduate");
    expect(calls[0]?.init?.method).toBe("POST");
  });

  test("maps 200 to ok with PR details", async () => {
    const { fetchImpl } = stubFetch(
      jsonResponse(200, {
        success: true,
        data: {
          prUrl: "https://github.com/o/r/pull/42",
          branch: "feat/prop_1",
          commitSha: "abc123",
          committed: true,
        },
      }),
    );
    const result = await graduateProposal("prop_1", { fetchImpl });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.prUrl).toBe("https://github.com/o/r/pull/42");
    expect(result.branch).toBe("feat/prop_1");
    expect(result.commitSha).toBe("abc123");
    expect(result.committed).toBe(true);
  });

  test("maps 404 to not_found", async () => {
    const { fetchImpl } = stubFetch(
      jsonResponse(404, { success: false, error: { message: "not found" } }),
    );
    const result = await graduateProposal("prop_x", { fetchImpl });
    expect(result.kind).toBe("not_found");
  });

  test("maps 422 to not_approved with the message", async () => {
    const { fetchImpl } = stubFetch(
      jsonResponse(422, {
        success: false,
        error: { message: "Proposal is not approved." },
      }),
    );
    const result = await graduateProposal("prop_1", { fetchImpl });
    expect(result.kind).toBe("not_approved");
    if (result.kind !== "not_approved") return;
    expect(result.message).toBe("Proposal is not approved.");
  });

  test("maps 503 to unavailable with the message", async () => {
    const { fetchImpl } = stubFetch(
      jsonResponse(503, {
        success: false,
        error: { code: "SERVICE.UNAVAILABLE", message: "No GitHub token configured." },
      }),
    );
    const result = await graduateProposal("prop_1", { fetchImpl });
    expect(result.kind).toBe("unavailable");
    if (result.kind !== "unavailable") return;
    expect(result.message).toBe("No GitHub token configured.");
  });

  test("maps 401 to denied", async () => {
    const { fetchImpl } = stubFetch(
      jsonResponse(401, {
        success: false,
        error: { code: "AUTHZ_DENIED", message: "Access denied" },
      }),
    );
    const result = await graduateProposal("prop_1", { fetchImpl });
    expect(result.kind).toBe("denied");
  });

  test("maps 403 to denied", async () => {
    const { fetchImpl } = stubFetch(
      jsonResponse(403, {
        success: false,
        error: { code: "AUTHZ_DENIED", message: "Access denied" },
      }),
    );
    const result = await graduateProposal("prop_1", { fetchImpl });
    expect(result.kind).toBe("denied");
  });

  test("maps 500 to error with the message", async () => {
    const { fetchImpl } = stubFetch(
      jsonResponse(500, { success: false, error: { message: "internal error" } }),
    );
    const result = await graduateProposal("prop_1", { fetchImpl });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toBe("internal error");
  });

  test("maps a transport throw to error", async () => {
    const fetchImpl = (async () => {
      throw new Error("connection refused");
    }) as typeof fetch;
    const result = await graduateProposal("prop_1", { fetchImpl });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toBe("connection refused");
  });

  test("maps invalid JSON on a 200 to error", async () => {
    const { fetchImpl } = stubFetch(new Response("<<<", { status: 200 }));
    const result = await graduateProposal("prop_1", { fetchImpl });
    expect(result.kind).toBe("error");
  });
});
