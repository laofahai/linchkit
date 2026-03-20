import { describe, expect, it } from "bun:test";
import { defineState } from "@linchkit/core";
import { getAvailableTransitions, testStateMachine } from "../src/test-state";

const lifecycle = defineState({
  name: "request_lifecycle",
  schema: "purchase_request",
  field: "status",
  initial: "draft",
  states: ["draft", "submitted", "approved", "rejected", "cancelled"],
  transitions: [
    { from: "draft", to: "submitted", action: "submit_request" },
    { from: "submitted", to: "approved", action: "approve_request" },
    { from: "submitted", to: "rejected", action: "reject_request" },
    { from: "rejected", to: "draft", action: "revise_request" },
    { from: ["draft", "submitted"], to: "cancelled", action: "cancel_request" },
  ],
});

describe("testStateMachine", () => {
  it("should allow valid transition", () => {
    const result = testStateMachine(lifecycle, { from: "draft", to: "submitted" });
    expect(result.allowed).toBe(true);
    expect(result.action).toBe("submit_request");
  });

  it("should reject invalid transition", () => {
    const result = testStateMachine(lifecycle, { from: "draft", to: "approved" });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("No transition");
  });

  it("should handle multi-source transitions", () => {
    const fromDraft = testStateMachine(lifecycle, { from: "draft", to: "cancelled" });
    expect(fromDraft.allowed).toBe(true);

    const fromSubmitted = testStateMachine(lifecycle, { from: "submitted", to: "cancelled" });
    expect(fromSubmitted.allowed).toBe(true);

    const fromApproved = testStateMachine(lifecycle, { from: "approved", to: "cancelled" });
    expect(fromApproved.allowed).toBe(false);
  });

  it("should reject non-existent states", () => {
    const result = testStateMachine(lifecycle, { from: "invalid", to: "submitted" });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("does not exist");
  });

  it("should filter by action when provided", () => {
    const correct = testStateMachine(lifecycle, {
      from: "draft",
      to: "submitted",
      action: "submit_request",
    });
    expect(correct.allowed).toBe(true);

    const wrong = testStateMachine(lifecycle, {
      from: "draft",
      to: "submitted",
      action: "wrong_action",
    });
    expect(wrong.allowed).toBe(false);
  });
});

describe("getAvailableTransitions", () => {
  it("should return all transitions from a state", () => {
    const transitions = getAvailableTransitions(lifecycle, "submitted");
    expect(transitions).toHaveLength(3); // approved, rejected, cancelled
    expect(transitions.map((t) => t.to).sort()).toEqual(["approved", "cancelled", "rejected"]);
  });

  it("should return empty array for terminal state", () => {
    const transitions = getAvailableTransitions(lifecycle, "approved");
    expect(transitions).toHaveLength(0);
  });

  it("should return transitions for initial state", () => {
    const transitions = getAvailableTransitions(lifecycle, "draft");
    expect(transitions).toHaveLength(2); // submitted, cancelled
  });
});
