/**
 * Tests for the chat assistant's schema-change routing — the 4th
 * "say → exists" (说→有) channel.
 *
 * `decideSchemaFallback` is the pure decision reached AFTER `resolveIntent`
 * found no runtime action (i.e. `decideIntentRouting` returned `chat-fallback`).
 * It is the seam the component uses in `handleSend`, so testing it covers the
 * "schema-change utterance → schema proposal card" routing without a DOM
 * (this package's tests are logic-only).
 *
 * We also drive the two-resolver chain end to end at the client level:
 * `resolveIntent` → non-action, then `resolveSchemaIntent` → `proposal_draft`,
 * and assert the combined decision is a schema proposal — proving the fallback
 * fires exactly when a runtime action could NOT be matched.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const store = new Map<string, string>();
if (typeof globalThis.localStorage === "undefined") {
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
      clear: () => store.clear(),
      get length() {
        return store.size;
      },
      key: (i: number) => [...store.keys()][i] ?? null,
    },
    configurable: true,
  });
}

import { decideIntentRouting, decideSchemaFallback } from "../src/components/ai-assistant";
import type { ResolveSchemaIntentResult } from "../src/lib/ai-api";
import { resolveIntent, resolveSchemaIntent } from "../src/lib/ai-api";

// ── decideSchemaFallback (pure) ──────────────────────────

describe("decideSchemaFallback", () => {
  test("routes a proposal_draft to a schema-proposal card", () => {
    const outcome: ResolveSchemaIntentResult = {
      kind: "proposal_draft",
      draft: { proposalId: "prop_1", ruleName: "threshold", confidence: 0.9 },
    };
    expect(decideSchemaFallback(outcome)).toEqual({
      kind: "schema-proposal",
      draft: { proposalId: "prop_1", ruleName: "threshold", confidence: 0.9 },
    });
  });

  test("routes clarification to chat fallback", () => {
    expect(decideSchemaFallback({ kind: "clarification", question: "which entity?" })).toEqual({
      kind: "chat-fallback",
    });
  });

  test("routes no_match to chat fallback", () => {
    expect(decideSchemaFallback({ kind: "no_match" })).toEqual({ kind: "chat-fallback" });
  });

  test("routes unavailable to chat fallback", () => {
    expect(decideSchemaFallback({ kind: "unavailable" })).toEqual({ kind: "chat-fallback" });
  });

  test("routes error to chat fallback", () => {
    expect(decideSchemaFallback({ kind: "error", message: "boom" })).toEqual({
      kind: "chat-fallback",
    });
  });
});

// ── Two-resolver chain (client level) ────────────────────

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let originalFetch: typeof fetch;
beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
});

describe("schema-change utterance routing chain", () => {
  test("resolveIntent → no-match, then resolveSchemaIntent → proposal_draft ⇒ schema-proposal", async () => {
    originalFetch = globalThis.fetch;
    // Route by endpoint: the action resolver returns no match; the schema
    // resolver mints a draft. This mirrors `handleSend`'s two-step fallback.
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      if (url === "/api/ai/resolve-intent") {
        return jsonResponse(200, { proposal: null });
      }
      if (url === "/api/ai/resolve-schema-intent") {
        return jsonResponse(200, {
          outcome: "proposal_draft",
          proposalId: "prop_77",
          proposalStatus: "draft",
          ruleName: "manager_approval_threshold",
          targetEntity: "purchase_order",
          confidence: 0.86,
          explanation: "Raise the manager-approval threshold to 20000",
        });
      }
      throw new Error(`unexpected url ${url}`);
    }) as typeof fetch;

    // Step 1 — runtime action resolution finds nothing → chat-fallback.
    const intent = await resolveIntent("raise the manager-approval threshold to 20000");
    const actionDecision = decideIntentRouting(intent);
    expect(actionDecision.kind).toBe("chat-fallback");

    // Step 2 — the schema-intent fallback mints a draft → schema-proposal card.
    const schema = await resolveSchemaIntent("raise the manager-approval threshold to 20000");
    const schemaDecision = decideSchemaFallback(schema);
    expect(schemaDecision.kind).toBe("schema-proposal");
    if (schemaDecision.kind !== "schema-proposal") return;
    expect(schemaDecision.draft.proposalId).toBe("prop_77");
    expect(schemaDecision.draft.ruleName).toBe("manager_approval_threshold");
  });

  test("entity_proposal_draft also routes to a schema-proposal (isEntity flag)", async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      jsonResponse(200, {
        outcome: "entity_proposal_draft",
        proposalId: "prop_88",
        proposalStatus: "draft",
        ruleName: "supplier",
        confidence: 0.8,
      })) as typeof fetch;

    const schema = await resolveSchemaIntent("add a supplier entity");
    const decision = decideSchemaFallback(schema);
    expect(decision.kind).toBe("schema-proposal");
    if (decision.kind !== "schema-proposal") return;
    expect(decision.draft.isEntity).toBe(true);
  });
});
