/**
 * Tests for `swapAlternative` and `resolveIntent` (Spec 52 §2.6 follow-up).
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

import { swapAlternative } from "../src/components/action-proposal-card";
import type { IntentAlternative, IntentResolution } from "../src/lib/ai-api";
import { resolveIntent } from "../src/lib/ai-api";

function makeIntent(overrides: Partial<IntentResolution> = {}): IntentResolution {
  return {
    action: "primary_action",
    schema: "primary_entity",
    input: { x: 1 },
    missingFields: [],
    confidence: 0.6,
    explanation: "Primary explanation",
    actionLabel: "Primary",
    actionDescription: "Primary description",
    inputSchema: { x: { type: "number", required: false } },
    ...overrides,
  };
}
function makeAlt(overrides: Partial<IntentAlternative> = {}): IntentAlternative {
  return {
    action: "alt_action",
    input: { y: 2 },
    confidence: 0.55,
    missingFields: [],
    explanation: "Alt explanation",
    ...overrides,
  };
}

describe("swapAlternative", () => {
  test("returns null when alternatives is undefined", () => {
    expect(swapAlternative(makeIntent({ alternatives: undefined }), 0)).toBeNull();
  });
  test("returns null when alternatives is empty", () => {
    expect(swapAlternative(makeIntent({ alternatives: [] }), 0)).toBeNull();
  });
  test("returns null on out-of-range index", () => {
    const intent = makeIntent({ alternatives: [makeAlt()] });
    expect(swapAlternative(intent, -1)).toBeNull();
    expect(swapAlternative(intent, 1)).toBeNull();
    expect(swapAlternative(intent, 99)).toBeNull();
  });
  test("promotes the chosen alternative into the primary slot", () => {
    const alt = makeAlt({
      action: "approve_order",
      input: { id: "o1" },
      confidence: 0.5,
      missingFields: ["reason"],
      explanation: "Approve order o1",
    });
    const next = swapAlternative(makeIntent({ alternatives: [alt] }), 0);
    expect(next).not.toBeNull();
    if (!next) return;
    expect(next.action).toBe("approve_order");
    expect(next.input).toEqual({ id: "o1" });
    expect(next.confidence).toBe(0.5);
    expect(next.missingFields).toEqual(["reason"]);
    expect(next.explanation).toBe("Approve order o1");
    expect(next.actionLabel).toBe("approve_order");
    expect(next.actionDescription).toBeUndefined();
    expect(next.inputSchema).toEqual({});
    expect(next.schema).toBe("approve_order");
  });
  test("demotes the previous primary into alternatives, preserving display metadata", () => {
    const intent = makeIntent({
      action: "primary_action",
      schema: "primary_entity",
      actionLabel: "Primary",
      actionDescription: "Primary description",
      inputSchema: { x: { type: "number", required: false } },
      input: { x: 1 },
      confidence: 0.6,
      explanation: "Primary explanation",
      missingFields: ["m"],
      alternatives: [makeAlt({ action: "alt_a", confidence: 0.55 })],
    });
    const next = swapAlternative(intent, 0);
    expect(next).not.toBeNull();
    if (!next) return;
    expect(next.alternatives?.length).toBe(1);
    const r = next.alternatives?.[0];
    expect(r?.action).toBe("primary_action");
    expect(r?.schema).toBe("primary_entity");
    expect(r?.actionLabel).toBe("Primary");
    expect(r?.actionDescription).toBe("Primary description");
    expect(r?.inputSchema).toEqual({ x: { type: "number", required: false } });
  });
  test("swap is reversible", () => {
    const intent = makeIntent({
      action: "primary_action",
      schema: "primary_entity",
      actionLabel: "Primary",
      actionDescription: "Primary description",
      inputSchema: { x: { type: "number", required: false } },
      input: { x: 1 },
      confidence: 0.6,
      missingFields: [],
      explanation: "Primary explanation",
      alternatives: [makeAlt({ action: "alt_a", confidence: 0.55, input: { y: 2 } })],
    });
    const after = swapAlternative(intent, 0);
    expect(after?.action).toBe("alt_a");
    // biome-ignore lint/style/noNonNullAssertion: after is validated by the expect above
    const restored = swapAlternative(after!, 0);
    expect(restored?.action).toBe("primary_action");
    expect(restored?.schema).toBe("primary_entity");
    expect(restored?.actionLabel).toBe("Primary");
    expect(restored?.inputSchema).toEqual({ x: { type: "number", required: false } });
  });
  test("swap-IN uses backend-enriched alternative metadata when present", () => {
    const next = swapAlternative(
      makeIntent({
        alternatives: [
          makeAlt({
            action: "alt_a",
            confidence: 0.55,
            input: { id: "x" },
            schema: "alt_entity",
            actionLabel: "Alternative A",
            actionDescription: "Does the alternative thing",
            inputSchema: { id: { type: "string", required: true } },
          }),
        ],
      }),
      0,
    );
    expect(next?.schema).toBe("alt_entity");
    expect(next?.actionLabel).toBe("Alternative A");
    expect(next?.actionDescription).toBe("Does the alternative thing");
    expect(next?.inputSchema).toEqual({ id: { type: "string", required: true } });
  });
  test("preserves remaining alternatives sorted by confidence DESC", () => {
    const intent = makeIntent({
      action: "primary_action",
      confidence: 0.65,
      alternatives: [
        makeAlt({ action: "alt_high", confidence: 0.6 }),
        makeAlt({ action: "alt_mid", confidence: 0.5 }),
        makeAlt({ action: "alt_low", confidence: 0.45 }),
      ],
    });
    const next = swapAlternative(intent, 2);
    expect(next?.action).toBe("alt_low");
    expect(next?.alternatives?.map((a) => a.action)).toEqual([
      "primary_action",
      "alt_high",
      "alt_mid",
    ]);
  });
});

interface CapturedRequest {
  url: string;
  method?: string;
  body: unknown;
  headers: Record<string, string>;
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
  if (originalFetch) globalThis.fetch = originalFetch;
});

describe("resolveIntent", () => {
  test("returns { kind: 'proposal' } when the server returns a proposal", async () => {
    const proposalView = makeIntent({
      action: "submit_request",
      alternatives: [makeAlt({ action: "draft_request", confidence: 0.5 })],
    });
    installFetch({ status: 200, body: { proposal: proposalView } });
    const result = await resolveIntent("submit a request");
    expect(result.kind).toBe("proposal");
    if (result.kind !== "proposal") return;
    expect(result.proposal.action).toBe("submit_request");
    expect(result.proposal.alternatives?.[0]?.action).toBe("draft_request");
    expect(captured?.url).toBe("/api/ai/resolve-intent");
    expect(captured?.method).toBe("POST");
    expect(captured?.body).toEqual({ prompt: "submit a request", scope: undefined });
  });
  test("returns { kind: 'unavailable' } on 503", async () => {
    installFetch({
      status: 503,
      body: {
        success: false,
        error: { code: "AI.UNAVAILABLE", message: "AI service is not configured." },
      },
    });
    expect(await resolveIntent("anything")).toEqual({ kind: "unavailable" });
  });
  test("returns { kind: 'no-match' } when server returns 200 + proposal:null", async () => {
    installFetch({ status: 200, body: { proposal: null } });
    expect(await resolveIntent("gibberish")).toEqual({ kind: "no-match" });
  });
  test("returns { kind: 'no-match' } when server omits the proposal field", async () => {
    installFetch({ status: 200, body: {} });
    expect(await resolveIntent("anything")).toEqual({ kind: "no-match" });
  });
  test("throws on non-2xx, non-503 responses", async () => {
    installFetch({
      status: 500,
      body: { success: false, error: { code: "AI.INTERNAL", message: "boom" } },
    });
    await expect(resolveIntent("anything")).rejects.toThrow("AI intent resolution failed");
  });
  test("forwards optional scope in the request body", async () => {
    installFetch({ status: 200, body: { proposal: null } });
    await resolveIntent("create a request", {
      entityFilter: ["request"],
      actionFilter: ["submit_request"],
    });
    expect(captured?.body).toEqual({
      prompt: "create a request",
      scope: { entityFilter: ["request"], actionFilter: ["submit_request"] },
    });
  });
});
