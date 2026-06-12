/**
 * `requestEntityOnchange` transport tests (Spec 64 §4.1).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const _store = new Map<string, string>();
if (typeof globalThis.localStorage === "undefined") {
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (k: string) => _store.get(k) ?? null,
      setItem: (k: string, v: string) => _store.set(k, v),
      removeItem: (k: string) => _store.delete(k),
      clear: () => _store.clear(),
      get length() {
        return _store.size;
      },
      key: (i: number) => [..._store.keys()][i] ?? null,
    },
    configurable: true,
  });
}

import { requestEntityOnchange } from "../src/lib/entity-meta";

interface CapturedRequest {
  url: string;
  method?: string;
  body: unknown;
  headers: Record<string, string>;
  signal?: AbortSignal | null;
}
let captured: CapturedRequest | null;
let originalFetch: typeof fetch;
function installFetch(response: { status: number; body: unknown }) {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured = {
      url: typeof input === "string" ? input : (input as URL).toString(),
      method: init?.method,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
      headers: (init?.headers as Record<string, string>) ?? {},
      signal: (init?.signal as AbortSignal | null | undefined) ?? null,
    };
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}
beforeEach(() => {
  captured = null;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("requestEntityOnchange", () => {
  test("posts { changedField, values } to /api/entities/:name/onchange", async () => {
    installFetch({ status: 200, body: { updates: { unit_price: 9.99 } } });
    const result = await requestEntityOnchange({
      entity: "purchase_item",
      changedField: "product_id",
      values: { product_id: "p1", quantity: 2 },
    });
    expect(captured?.url).toBe("/api/entities/purchase_item/onchange");
    expect(captured?.method).toBe("POST");
    expect(captured?.body).toEqual({
      changedField: "product_id",
      values: { product_id: "p1", quantity: 2 },
    });
    expect(result.updates).toEqual({ unit_price: 9.99 });
  });
  test("returns { updates: {} } when the response omits updates", async () => {
    installFetch({ status: 200, body: {} });
    const result = await requestEntityOnchange({
      entity: "purchase_item",
      changedField: "product_id",
      values: {},
    });
    expect(result.updates).toEqual({});
    expect(result.warnings).toBeUndefined();
  });
  test("forwards warnings array when present", async () => {
    installFetch({ status: 200, body: { updates: {}, warnings: ["budget exceeded"] } });
    const result = await requestEntityOnchange({
      entity: "purchase_item",
      changedField: "product_id",
      values: {},
    });
    expect(result.warnings).toEqual(["budget exceeded"]);
  });
  test("URL-encodes the entity name", async () => {
    installFetch({ status: 200, body: { updates: {} } });
    await requestEntityOnchange({ entity: "weird name", changedField: "x", values: {} });
    expect(captured?.url).toBe("/api/entities/weird%20name/onchange");
  });
  test("throws with the server-provided error message on non-2xx", async () => {
    installFetch({
      status: 400,
      body: { success: false, error: { code: "INVALID", message: "field unknown" } },
    });
    await expect(
      requestEntityOnchange({ entity: "x", changedField: "y", values: {} }),
    ).rejects.toThrow("field unknown");
  });
  test("throws a generic message when the error body is non-JSON", async () => {
    globalThis.fetch = (async () =>
      new Response("Internal Server Error", {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      })) as typeof fetch;
    await expect(
      requestEntityOnchange({ entity: "x", changedField: "y", values: {} }),
    ).rejects.toThrow("Onchange request failed (500)");
  });
  test("forwards AbortSignal so callers can cancel stale requests", async () => {
    installFetch({ status: 200, body: { updates: {} } });
    const controller = new AbortController();
    await requestEntityOnchange({
      entity: "x",
      changedField: "y",
      values: {},
      signal: controller.signal,
    });
    expect(captured?.signal).toBe(controller.signal);
  });
});
