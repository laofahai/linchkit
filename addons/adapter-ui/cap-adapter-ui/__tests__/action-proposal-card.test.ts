/**
 * Tests for `swapAlternative` and `resolveIntent` (Spec 52 §2.6 follow-up).
 *
 * The existing test setup is logic-only (no happy-dom / jsdom), so the
 * `ActionProposalCard` swap behavior is exercised through the pure helper
 * `swapAlternative` exported from the component module — the helper covers
 * every observable state transition the click-handler triggers (primary
 * replacement, alternatives reorder, reversibility).
 *
 * `resolveIntent` is covered with fetch mocks for the three discriminated
 * outcomes the consumer (`ai-assistant.tsx`) needs to switch on: proposal,
 * service-unavailable (503), and no-match (200 + null).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// Minimal localStorage shim — api.ts reads `linchkit:token` for auth headers.
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

import { swapAlternative } from "../src/components/action-proposal-card";
import type { IntentAlternative, IntentResolution } from "../src/lib/api";
import { resolveIntent } from "../src/lib/api";

// ── Fixtures ────────────────────────────────────────────────

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
    inputSchema: {
      x: { type: "number", required: false },
    },
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

// ── swapAlternative ────────────────────────────────────────

describe("swapAlternative", () => {
  test("returns null when alternatives is undefined", () => {
    const intent = makeIntent({ alternatives: undefined });
    expect(swapAlternative(intent, 0)).toBeNull();
  });

  test("returns null when alternatives is empty", () => {
    const intent = makeIntent({ alternatives: [] });
    expect(swapAlternative(intent, 0)).toBeNull();
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
    const intent = makeIntent({ alternatives: [alt] });

    const next = swapAlternative(intent, 0);
    expect(next).not.toBeNull();
    if (!next) return;

    expect(next.action).toBe("approve_order");
    expect(next.input).toEqual({ id: "o1" });
    expect(next.confidence).toBe(0.5);
    expect(next.missingFields).toEqual(["reason"]);
    expect(next.explanation).toBe("Approve order o1");
    // Display metadata is synthesized when the backend did not enrich the alt.
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

    expect(next.alternatives).toBeDefined();
    expect(next.alternatives?.length).toBe(1);
    const restoredPrimary = next.alternatives?.[0];
    expect(restoredPrimary?.action).toBe("primary_action");
    expect(restoredPrimary?.input).toEqual({ x: 1 });
    expect(restoredPrimary?.confidence).toBe(0.6);
    expect(restoredPrimary?.missingFields).toEqual(["m"]);
    expect(restoredPrimary?.explanation).toBe("Primary explanation");
    // Display metadata must round-trip on the demoted primary so swap-back
    // is fully reversible.
    expect(restoredPrimary?.schema).toBe("primary_entity");
    expect(restoredPrimary?.actionLabel).toBe("Primary");
    expect(restoredPrimary?.actionDescription).toBe("Primary description");
    expect(restoredPrimary?.inputSchema).toEqual({ x: { type: "number", required: false } });
  });

  test("swap is reversible — swap-back restores ALL display metadata, not just identity", () => {
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
    expect(after).not.toBeNull();
    if (!after) return;
    expect(after.action).toBe("alt_a");

    // The previous primary now sits at index 0 of alternatives. Swap back.
    const restored = swapAlternative(after, 0);
    expect(restored).not.toBeNull();
    if (!restored) return;
    expect(restored.action).toBe("primary_action");
    expect(restored.input).toEqual({ x: 1 });
    expect(restored.confidence).toBe(0.6);
    // Non-lossy: display metadata fully restored.
    expect(restored.schema).toBe("primary_entity");
    expect(restored.actionLabel).toBe("Primary");
    expect(restored.actionDescription).toBe("Primary description");
    expect(restored.inputSchema).toEqual({ x: { type: "number", required: false } });
  });

  test("swap-IN uses backend-enriched alternative metadata when present", () => {
    const enrichedAlt = makeAlt({
      action: "alt_a",
      confidence: 0.55,
      input: { id: "x" },
      schema: "alt_entity",
      actionLabel: "Alternative A",
      actionDescription: "Does the alternative thing",
      inputSchema: { id: { type: "string", required: true } },
    });
    const intent = makeIntent({ alternatives: [enrichedAlt] });

    const next = swapAlternative(intent, 0);
    expect(next).not.toBeNull();
    if (!next) return;
    expect(next.schema).toBe("alt_entity");
    expect(next.actionLabel).toBe("Alternative A");
    expect(next.actionDescription).toBe("Does the alternative thing");
    expect(next.inputSchema).toEqual({ id: { type: "string", required: true } });
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

    // Swap the lowest-confidence alternative in. Remaining should be
    // [previousPrimary@0.65, alt_high@0.6, alt_mid@0.5] sorted DESC.
    const next = swapAlternative(intent, 2);
    expect(next).not.toBeNull();
    if (!next) return;
    expect(next.action).toBe("alt_low");
    expect(next.alternatives?.map((a) => a.action)).toEqual([
      "primary_action",
      "alt_high",
      "alt_mid",
    ]);
  });
});

// ── resolveIntent transport ─────────────────────────────────

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
  if (originalFetch) {
    globalThis.fetch = originalFetch;
  }
});

describe("resolveIntent", () => {
  test("returns { kind: 'proposal' } when the server returns a proposal", async () => {
    const proposalView: IntentResolution = makeIntent({
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

  test("returns { kind: 'unavailable' } on 503 instead of throwing or returning null", async () => {
    installFetch({
      status: 503,
      body: {
        success: false,
        error: { code: "AI.UNAVAILABLE", message: "AI service is not configured." },
      },
    });

    const result = await resolveIntent("anything");
    expect(result).toEqual({ kind: "unavailable" });
  });

  test("returns { kind: 'no-match' } when server returns 200 + proposal:null", async () => {
    installFetch({ status: 200, body: { proposal: null } });

    const result = await resolveIntent("gibberish");
    expect(result).toEqual({ kind: "no-match" });
  });

  test("returns { kind: 'no-match' } when server omits the proposal field", async () => {
    installFetch({ status: 200, body: {} });

    const result = await resolveIntent("anything");
    expect(result).toEqual({ kind: "no-match" });
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
