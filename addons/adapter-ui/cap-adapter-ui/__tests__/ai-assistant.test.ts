/**
 * Tests for `decideIntentRouting` (issue #238).
 *
 * The AI assistant previously gated proposals at `confidence >= 0.5` and
 * silently fell back to the general `/api/ai/chat` endpoint for everything
 * else (low-confidence proposals, no-match, unavailable, transport errors).
 * That endpoint runs with `allowActionExecution=false`, so actionable
 * prompts dead-ended as "creating..." chat replies that never mutated
 * the database.
 *
 * The fix targets the specific dead-end without regressing read-only chat:
 *  - ANY proposal (regardless of confidence) → render the card. The card
 *    already exposes alternatives + "Did you mean" pills for low confidence.
 *  - no-match / transport-error → fall back to chat (preserves Q&A,
 *    "summarize this record", and other read-only flows).
 *  - unavailable → fall back to chat AND emit a toast notification, since
 *    the user should know the structured action path is degraded.
 *
 * The component itself is JSX-only — we test the pure decision helper
 * here since the existing test setup is logic-only (no happy-dom / jsdom),
 * matching the pattern of `proposal-impact-preview.test.ts`.
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
    inputSchema: {
      name: { type: "string", required: true },
    },
    ...overrides,
  };
}

describe("decideIntentRouting (issue #238)", () => {
  test("routes a high-confidence proposal to the proposal card", () => {
    const proposal = makeIntent({ confidence: 0.9 });
    const decision = decideIntentRouting({ kind: "proposal", proposal });
    expect(decision).toEqual({ kind: "proposal", proposal });
  });

  test("routes a low-confidence proposal to the proposal card (no chat fallback)", () => {
    // Pre-fix this branch fell through to chat with `allowActionExecution=false`,
    // producing the "creating..." dead-end reported by the user. Now the card
    // surfaces — its alternative pills let the user disambiguate inline.
    const proposal = makeIntent({ confidence: 0.3 });
    const decision = decideIntentRouting({ kind: "proposal", proposal });
    expect(decision.kind).toBe("proposal");
    if (decision.kind !== "proposal") return;
    expect(decision.proposal.confidence).toBe(0.3);
    expect(decision.proposal).toBe(proposal);
  });

  test("routes a borderline-confidence proposal (just below 0.5) to the card", () => {
    const proposal = makeIntent({ confidence: 0.49 });
    const decision = decideIntentRouting({ kind: "proposal", proposal });
    expect(decision.kind).toBe("proposal");
  });

  test("routes a no-match outcome to chat fallback (preserves Q&A / read-only flows)", () => {
    // Read-only conversational prompts ("hello", "summarize this record")
    // resolve to no-match; they must still reach chat, otherwise the
    // assistant becomes useless for non-action tasks (codex P1 review).
    const decision = decideIntentRouting({ kind: "no-match" });
    expect(decision).toEqual({ kind: "chat-fallback" });
  });

  test("routes an unavailable outcome to chat fallback with service-unavailable notice", () => {
    // 503 should still try chat (it may be up while resolver is down) but
    // surface a toast so the user knows the structured action path is
    // degraded.
    const decision = decideIntentRouting({ kind: "unavailable" });
    expect(decision).toEqual({
      kind: "chat-fallback",
      notify: "service-unavailable",
    });
  });

  test("routes a transport-error outcome to chat fallback (no toast)", () => {
    const decision = decideIntentRouting({ kind: "transport-error" });
    expect(decision).toEqual({ kind: "chat-fallback" });
  });
});
