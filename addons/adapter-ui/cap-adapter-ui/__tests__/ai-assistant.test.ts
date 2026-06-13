/**
 * Tests for `decideIntentRouting` (issue #238).
 */
import { describe, expect, test } from "bun:test";
import { decideIntentRouting } from "../src/components/ai-assistant";
import type { IntentResolution } from "../src/lib/ai-api";

function makeIntent(overrides: Partial<IntentResolution> = {}): IntentResolution {
  return {
    action: "create_department",
    schema: "department",
    input: { name: "Operations Management Center" },
    missingFields: [],
    confidence: 0.6,
    explanation: "Create a department",
    actionLabel: "Create Department",
    actionDescription: "Create a new department record",
    inputSchema: { name: { type: "string", required: true } },
    ...overrides,
  };
}

describe("decideIntentRouting (issue #238)", () => {
  test("routes a high-confidence proposal to the proposal card", () => {
    const proposal = makeIntent({ confidence: 0.9 });
    expect(decideIntentRouting({ kind: "proposal", proposal })).toEqual({
      kind: "proposal",
      proposal,
    });
  });
  test("routes a low-confidence proposal to the proposal card (no chat fallback)", () => {
    const proposal = makeIntent({ confidence: 0.3 });
    const decision = decideIntentRouting({ kind: "proposal", proposal });
    expect(decision.kind).toBe("proposal");
    if (decision.kind !== "proposal") return;
    expect(decision.proposal.confidence).toBe(0.3);
    expect(decision.proposal).toBe(proposal);
  });
  test("routes a borderline-confidence proposal (just below 0.5) to the card", () => {
    const proposal = makeIntent({ confidence: 0.49 });
    expect(decideIntentRouting({ kind: "proposal", proposal }).kind).toBe("proposal");
  });
  test("routes a no-match outcome to chat fallback", () => {
    expect(decideIntentRouting({ kind: "no-match" })).toEqual({ kind: "chat-fallback" });
  });
  test("routes an unavailable outcome to chat fallback with service-unavailable notice", () => {
    expect(decideIntentRouting({ kind: "unavailable" })).toEqual({
      kind: "chat-fallback",
      notify: "service-unavailable",
    });
  });
  test("routes a transport-error outcome to chat fallback (no toast)", () => {
    expect(decideIntentRouting({ kind: "transport-error" })).toEqual({ kind: "chat-fallback" });
  });
});
