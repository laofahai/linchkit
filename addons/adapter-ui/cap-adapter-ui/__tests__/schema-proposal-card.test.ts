/**
 * Tests for the SchemaProposalCard logic — the chat assistant's 4th
 * "say → exists" (说→有) channel.
 *
 * This package's test setup is logic-only (no happy-dom / jsdom — see
 * proposal-impact-preview.test.ts), so we test the card's PURE building blocks
 * rather than the rendered React:
 *   - `toSchemaProposalDisplay` — sparse draft → display fields.
 *   - `mapGraduateResult`       — graduate result → done(prUrl) / error(key).
 *   - the `approveProposal` + `graduateProposal` clients the card composes,
 *     driven through the real approve → Open PR → prUrl flow and the error
 *     arms, via an injected fetch stub (never a leaked global mock).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// Logic-only runner has no DOM; the clients call getAuthHeaders() which reads
// localStorage. Mirror the shim used across the other api-client tests.
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

import {
  formatConfidencePct,
  mapGraduateResult,
  toSchemaProposalDisplay,
} from "../src/components/schema-proposal-card-helpers";
import type { SchemaIntentDraft } from "../src/lib/ai-api";
import { approveProposal, graduateProposal } from "../src/lib/proposal-api";

// ── formatConfidencePct ──────────────────────────────────

describe("formatConfidencePct", () => {
  test("formats a fraction as a percentage", () => {
    expect(formatConfidencePct(0.82)).toBe("82%");
  });
  test("returns an em dash for undefined / non-finite", () => {
    expect(formatConfidencePct(undefined)).toBe("—");
    expect(formatConfidencePct(Number.NaN)).toBe("—");
    expect(formatConfidencePct(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

// ── toSchemaProposalDisplay ──────────────────────────────

describe("toSchemaProposalDisplay", () => {
  test("maps a full rule draft to display fields", () => {
    const draft: SchemaIntentDraft = {
      proposalId: "prop_1",
      proposalStatus: "draft",
      ruleName: "manager_approval_threshold",
      targetEntity: "purchase_order",
      confidence: 0.9,
      explanation: "Raise the manager-approval threshold to 20000",
      requiresCodeChange: true,
      diffSummary: "- threshold: 10000\n+ threshold: 20000",
    };
    expect(toSchemaProposalDisplay(draft)).toEqual({
      name: "manager_approval_threshold",
      statusLabel: "draft",
      confidencePct: "90%",
      explanation: "Raise the manager-approval threshold to 20000",
      targetEntity: "purchase_order",
      proposalId: "prop_1",
      requiresCodeChange: true,
      diffSummary: "- threshold: 10000\n+ threshold: 20000",
      isEntity: false,
    });
  });

  test("defaults status to 'draft', requiresCodeChange to false, isEntity to false", () => {
    const display = toSchemaProposalDisplay({});
    expect(display.statusLabel).toBe("draft");
    expect(display.confidencePct).toBe("—");
    expect(display.requiresCodeChange).toBe(false);
    expect(display.isEntity).toBe(false);
    expect(display.name).toBeUndefined();
    expect(display.proposalId).toBeUndefined();
  });

  test("flags an entity draft", () => {
    expect(toSchemaProposalDisplay({ isEntity: true }).isEntity).toBe(true);
  });
});

// ── mapGraduateResult ────────────────────────────────────

describe("mapGraduateResult", () => {
  test("maps ok to done with the PR url", () => {
    const mapped = mapGraduateResult({
      kind: "ok",
      prUrl: "https://github.com/o/r/pull/7",
      branch: "feat/x",
      commitSha: "abc",
      committed: true,
    });
    expect(mapped).toEqual({ status: "done", prUrl: "https://github.com/o/r/pull/7" });
  });

  test("maps not_found to an error key", () => {
    expect(mapGraduateResult({ kind: "not_found" })).toEqual({
      status: "error",
      messageKey: "schemaProposal.graduateNotFound",
    });
  });

  test("maps not_approved / unavailable / error and forwards the raw message", () => {
    expect(mapGraduateResult({ kind: "not_approved", message: "not approved yet" })).toEqual({
      status: "error",
      messageKey: "schemaProposal.graduateNotApproved",
      rawMessage: "not approved yet",
    });
    expect(mapGraduateResult({ kind: "unavailable", message: "no token" })).toEqual({
      status: "error",
      messageKey: "schemaProposal.graduateUnavailable",
      rawMessage: "no token",
    });
    expect(mapGraduateResult({ kind: "error", message: "boom" })).toEqual({
      status: "error",
      messageKey: "schemaProposal.graduateError",
      rawMessage: "boom",
    });
  });

  test("maps denied to an error key (no raw message)", () => {
    expect(mapGraduateResult({ kind: "denied" })).toEqual({
      status: "error",
      messageKey: "schemaProposal.graduateDenied",
    });
  });
});

// ── Approve → Open PR flow (the clients the card composes) ─

interface CapturedRequest {
  url: string;
  method?: string;
}
let captured: CapturedRequest[];
let originalFetch: typeof fetch;

/** Install a global fetch stub that records every call and replays a queue. */
function installFetchQueue(responses: Array<{ status: number; body: unknown }>) {
  originalFetch = globalThis.fetch;
  let i = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({
      url: typeof input === "string" ? input : (input as URL).toString(),
      method: init?.method,
    });
    const response = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return new Response(JSON.stringify(response?.body), {
      status: response?.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

beforeEach(() => {
  captured = [];
  localStorage.clear();
});
afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
});

describe("approve → graduate flow", () => {
  test("Approve hits the approve endpoint, then Open PR hits graduate and yields prUrl", async () => {
    installFetchQueue([
      { status: 200, body: { success: true, data: { id: "prop_1", status: "approved" } } },
      {
        status: 200,
        body: {
          success: true,
          data: {
            prUrl: "https://github.com/o/r/pull/42",
            branch: "feat/prop_1",
            commitSha: "deadbeef",
            committed: true,
          },
        },
      },
    ]);

    // Phase 1 — Approve.
    const approved = await approveProposal("prop_1");
    expect(approved.id).toBe("prop_1");
    expect(captured[0]?.url).toBe("/api/proposals/prop_1/approve");
    expect(captured[0]?.method).toBe("POST");

    // Phase 2 — Open PR (graduate) → surfaces the PR url.
    const graduated = await graduateProposal("prop_1");
    expect(graduated.kind).toBe("ok");
    if (graduated.kind !== "ok") return;
    expect(graduated.prUrl).toBe("https://github.com/o/r/pull/42");
    expect(captured[1]?.url).toBe("/api/proposals/prop_1/graduate");

    // And the card mapping turns that into a done(prUrl) display.
    expect(mapGraduateResult(graduated)).toEqual({
      status: "done",
      prUrl: "https://github.com/o/r/pull/42",
    });
  });

  test("Approve surfaces a server error (card stays in approve phase)", async () => {
    installFetchQueue([
      { status: 200, body: { success: false, error: { message: "validation failed" } } },
    ]);
    await expect(approveProposal("prop_1")).rejects.toThrow("validation failed");
  });

  test("Open PR on a not-yet-approved proposal maps to a not_approved error", async () => {
    installFetchQueue([
      { status: 422, body: { success: false, error: { message: "Proposal is not approved." } } },
    ]);
    const graduated = await graduateProposal("prop_1");
    expect(mapGraduateResult(graduated)).toEqual({
      status: "error",
      messageKey: "schemaProposal.graduateNotApproved",
      rawMessage: "Proposal is not approved.",
    });
  });
});
