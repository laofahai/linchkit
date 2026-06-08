/**
 * Tests for the `fetchSchedulerStatus` client.
 *
 * Maps the server's JSON envelope (200 configured/unconfigured + 401/403 + 503
 * + other non-2xx + transport error / invalid JSON) onto a discriminated result
 * the UI renders. We inject a stub `fetch` via `fetchImpl` so the assertions
 * never rely on a GLOBAL fetch mock (which would leak across the batched suite).
 * Mirrors `proposal-graduate-api.test.ts`.
 */

import { beforeEach, describe, expect, test } from "bun:test";

// Minimal localStorage shim — the client calls getAuthHeaders() which reads
// localStorage. The bun test runner has no DOM; mirror proposal-graduate-api.test.ts.
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

import { fetchSchedulerStatus } from "../src/lib/evolution-api";

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

describe("fetchSchedulerStatus client", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("GETs the scheduler-status endpoint", async () => {
    const { fetchImpl, calls } = stubFetch(
      jsonResponse(200, { success: true, data: { configured: false } }),
    );
    await fetchSchedulerStatus({ fetchImpl });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/evolution/scheduler-status");
    // No explicit method → defaults to GET (read-only).
    expect(calls[0]?.init?.method).toBeUndefined();
  });

  test("maps 200 unconfigured to ok / configured:false", async () => {
    const { fetchImpl } = stubFetch(
      jsonResponse(200, { success: true, data: { configured: false } }),
    );
    const result = await fetchSchedulerStatus({ fetchImpl });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.status.configured).toBe(false);
  });

  test("maps 200 configured to ok with all fields", async () => {
    const { fetchImpl } = stubFetch(
      jsonResponse(200, {
        success: true,
        data: {
          configured: true,
          running: true,
          intervalMs: 300000,
          ticksStarted: 5,
          ticksCompleted: 4,
          lastTickStartedAt: "2026-06-08T10:00:00.000Z",
          lastTickCompletedAt: "2026-06-08T10:00:01.000Z",
          lastTickDurationMs: 1000,
          lastError: null,
          consecutiveErrors: 0,
        },
      }),
    );
    const result = await fetchSchedulerStatus({ fetchImpl });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok" || !result.status.configured) return;
    expect(result.status.running).toBe(true);
    expect(result.status.intervalMs).toBe(300000);
    expect(result.status.ticksStarted).toBe(5);
    expect(result.status.ticksCompleted).toBe(4);
    expect(result.status.lastTickCompletedAt).toBe("2026-06-08T10:00:01.000Z");
    expect(result.status.lastTickDurationMs).toBe(1000);
    expect(result.status.consecutiveErrors).toBe(0);
  });

  test("defaults missing fields on a configured:true body", async () => {
    const { fetchImpl } = stubFetch(
      jsonResponse(200, { success: true, data: { configured: true } }),
    );
    const result = await fetchSchedulerStatus({ fetchImpl });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok" || !result.status.configured) return;
    expect(result.status.running).toBe(false);
    expect(result.status.intervalMs).toBe(0);
    expect(result.status.ticksStarted).toBe(0);
    expect(result.status.ticksCompleted).toBe(0);
    expect(result.status.lastTickStartedAt).toBeNull();
    expect(result.status.lastTickCompletedAt).toBeNull();
    expect(result.status.lastTickDurationMs).toBeNull();
    expect(result.status.lastError).toBeNull();
    expect(result.status.consecutiveErrors).toBe(0);
  });

  test("treats a missing data block as unconfigured", async () => {
    const { fetchImpl } = stubFetch(jsonResponse(200, { success: true }));
    const result = await fetchSchedulerStatus({ fetchImpl });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.status.configured).toBe(false);
  });

  test("maps 401 to denied", async () => {
    const { fetchImpl } = stubFetch(
      jsonResponse(401, { success: false, error: { code: "AUTHZ_DENIED", message: "denied" } }),
    );
    const result = await fetchSchedulerStatus({ fetchImpl });
    expect(result.kind).toBe("denied");
  });

  test("maps 403 to denied", async () => {
    const { fetchImpl } = stubFetch(
      jsonResponse(403, { success: false, error: { code: "AUTHZ_DENIED", message: "denied" } }),
    );
    const result = await fetchSchedulerStatus({ fetchImpl });
    expect(result.kind).toBe("denied");
  });

  test("maps 503 (command layer not configured) to error with the message", async () => {
    const { fetchImpl } = stubFetch(
      jsonResponse(503, {
        success: false,
        error: { code: "SERVICE.UNAVAILABLE", message: "Command layer not configured." },
      }),
    );
    const result = await fetchSchedulerStatus({ fetchImpl });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toBe("Command layer not configured.");
  });

  test("maps another non-2xx to error with the message", async () => {
    const { fetchImpl } = stubFetch(
      jsonResponse(500, { success: false, error: { message: "boom" } }),
    );
    const result = await fetchSchedulerStatus({ fetchImpl });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toBe("boom");
  });

  test("maps a transport throw to error", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const result = await fetchSchedulerStatus({ fetchImpl });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toBe("network down");
  });

  test("maps invalid JSON on a 200 to error", async () => {
    const { fetchImpl } = stubFetch(new Response("not json", { status: 200 }));
    const result = await fetchSchedulerStatus({ fetchImpl });
    expect(result.kind).toBe("error");
  });
});
