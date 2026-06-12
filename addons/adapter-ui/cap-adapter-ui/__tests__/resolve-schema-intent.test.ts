/**
 * Tests for the `resolveSchemaIntent` client (Spec 52 — "说→有").
 *
 * The client maps the server's discriminated `ResolveSchemaIntentResponse`
 * (proposal_draft / clarification / no_match, plus 503 / 4xx-5xx / transport
 * error) onto a discriminated `ResolveSchemaIntentResult` the UI renders.
 *
 * We inject a stub `fetch` via the `fetchImpl` option so the assertions never
 * rely on a GLOBAL fetch mock — a global stub would leak across the batched
 * suite and clobber other tests' network calls. Each case builds its own
 * `Response` and asserts the mapping.
 */

import { beforeEach, describe, expect, test } from "bun:test";

// Minimal localStorage shim — the client calls getAuthHeaders() which reads
// localStorage. The bun test runner has no DOM; mirror tenant.test.ts.
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

import { resolveSchemaIntent } from "../src/lib/ai-api";

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

describe("resolveSchemaIntent client", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("posts the prompt to the resolve-schema-intent endpoint", async () => {
    const { fetchImpl, calls } = stubFetch(
      jsonResponse(200, { outcome: "no_match", reason: "n/a" }),
    );
    await resolveSchemaIntent("hello world", { fetchImpl });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/ai/resolve-schema-intent");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ prompt: "hello world" });
  });

  test("maps proposal_draft to a draft result with id/status/confidence", async () => {
    const { fetchImpl } = stubFetch(
      jsonResponse(200, {
        outcome: "proposal_draft",
        proposalId: "prop_123",
        proposalStatus: "draft",
        ruleName: "require_approver_high_value",
        targetEntity: "purchase_order",
        confidence: 0.82,
        explanation: "Require an approver when total > 10000",
      }),
    );
    const result = await resolveSchemaIntent("require approver for big orders", { fetchImpl });
    expect(result.kind).toBe("proposal_draft");
    if (result.kind !== "proposal_draft") return;
    expect(result.draft).toEqual({
      proposalId: "prop_123",
      proposalStatus: "draft",
      ruleName: "require_approver_high_value",
      targetEntity: "purchase_order",
      confidence: 0.82,
      explanation: "Require an approver when total > 10000",
    });
  });

  test("maps clarification to a clarification result with the question", async () => {
    const { fetchImpl } = stubFetch(
      jsonResponse(200, {
        outcome: "clarification",
        question: "Which entity should this rule apply to?",
        bestConfidence: 0.4,
      }),
    );
    const result = await resolveSchemaIntent("require approval", { fetchImpl });
    expect(result.kind).toBe("clarification");
    if (result.kind !== "clarification") return;
    expect(result.question).toBe("Which entity should this rule apply to?");
    expect(result.bestConfidence).toBe(0.4);
  });

  test("maps no_match to a no_match result with the reason", async () => {
    const { fetchImpl } = stubFetch(
      jsonResponse(200, {
        outcome: "no_match",
        reason: "No entity matched the description.",
        message: "try again",
      }),
    );
    const result = await resolveSchemaIntent("xyzzy", { fetchImpl });
    expect(result.kind).toBe("no_match");
    if (result.kind !== "no_match") return;
    expect(result.reason).toBe("No entity matched the description.");
    expect(result.message).toBe("try again");
  });

  test("maps 503 to an unavailable result with the structured message", async () => {
    const { fetchImpl } = stubFetch(
      jsonResponse(503, {
        success: false,
        error: {
          code: "SERVICE.UNAVAILABLE",
          message: "AI service is not configured.",
        },
      }),
    );
    const result = await resolveSchemaIntent("draft a rule", { fetchImpl });
    expect(result.kind).toBe("unavailable");
    if (result.kind !== "unavailable") return;
    expect(result.message).toBe("AI service is not configured.");
  });

  test("maps a 400 validation error to an error result", async () => {
    const { fetchImpl } = stubFetch(
      jsonResponse(400, {
        success: false,
        error: { code: "VALIDATION.FAILED", message: "prompt must be a non-empty string" },
      }),
    );
    const result = await resolveSchemaIntent("", { fetchImpl });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toBe("prompt must be a non-empty string");
  });

  test("maps a 500 to an error result", async () => {
    const { fetchImpl } = stubFetch(
      jsonResponse(500, {
        success: false,
        error: { code: "AI.RESOLVE_SCHEMA_INTENT.FAILED", message: "boom" },
      }),
    );
    const result = await resolveSchemaIntent("draft a rule", { fetchImpl });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toBe("boom");
  });

  test("maps a transport-level throw to an error result", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const result = await resolveSchemaIntent("draft a rule", { fetchImpl });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toBe("network down");
  });

  test("maps an unknown outcome to an error result", async () => {
    const { fetchImpl } = stubFetch(jsonResponse(200, { outcome: "something_new" }));
    const result = await resolveSchemaIntent("draft a rule", { fetchImpl });
    expect(result.kind).toBe("error");
  });

  test("falls back to a generic 503 message when the body is non-JSON", async () => {
    const { fetchImpl } = stubFetch(new Response("not json", { status: 503 }));
    const result = await resolveSchemaIntent("draft a rule", { fetchImpl });
    expect(result.kind).toBe("unavailable");
    if (result.kind !== "unavailable") return;
    // No structured message — `message` is undefined; the UI shows its own
    // localized "not configured" fallback.
    expect(result.message).toBeUndefined();
  });
});
