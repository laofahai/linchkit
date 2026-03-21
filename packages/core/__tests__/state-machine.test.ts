import { describe, expect, it } from "bun:test";
import {
  canTransition,
  createStateMachine,
  getAvailableActions,
  transition,
} from "../src/engine/state-machine";
import type { StateDefinition } from "../src/types/state";

// ── Test fixtures ───────────────────────────────────────

const orderDefinition: StateDefinition = {
  name: "order",
  schema: "Order",
  field: "status",
  initial: "draft",
  states: ["draft", "submitted", "approved", "rejected", "cancelled"],
  transitions: [
    { from: "draft", to: "submitted", action: "submit" },
    { from: "submitted", to: "approved", action: "approve" },
    { from: "submitted", to: "rejected", action: "reject" },
    { from: ["draft", "submitted"], to: "cancelled", action: "cancel" },
    { from: "rejected", to: "draft", action: "revise" },
  ],
};

const singleStateDefinition: StateDefinition = {
  name: "singleton",
  schema: "Singleton",
  field: "status",
  initial: "active",
  states: ["active"],
  transitions: [],
};

// ── Tests ───────────────────────────────────────────────

describe("createStateMachine", () => {
  it("creates a machine from a valid definition", () => {
    const machine = createStateMachine(orderDefinition);
    expect(machine.definition).toBe(orderDefinition);
  });

  it("throws if definition has no name", () => {
    expect(() => createStateMachine({ ...orderDefinition, name: "" })).toThrow("must have a name");
  });

  it("throws if states list is empty", () => {
    expect(() => createStateMachine({ ...orderDefinition, states: [] })).toThrow(
      "must have at least one state",
    );
  });

  it("throws if initial state is not in states list", () => {
    expect(() => createStateMachine({ ...orderDefinition, initial: "nonexistent" })).toThrow(
      'Initial state "nonexistent"',
    );
  });

  it("throws if a transition references an unknown source state", () => {
    expect(() =>
      createStateMachine({
        ...orderDefinition,
        transitions: [{ from: "unknown", to: "draft", action: "go" }],
      }),
    ).toThrow('unknown source state "unknown"');
  });

  it("throws if a transition references an unknown target state", () => {
    expect(() =>
      createStateMachine({
        ...orderDefinition,
        transitions: [{ from: "draft", to: "unknown", action: "go" }],
      }),
    ).toThrow('unknown target state "unknown"');
  });

  it("accepts a definition with no transitions", () => {
    const machine = createStateMachine(singleStateDefinition);
    expect(machine.definition.states).toEqual(["active"]);
  });
});

describe("transition", () => {
  const machine = createStateMachine(orderDefinition);

  it("performs a valid transition", () => {
    const result = transition(machine, "draft", "submit");
    expect(result.allowed).toBe(true);
    expect(result.from).toBe("draft");
    expect(result.to).toBe("submitted");
    expect(result.action).toBe("submit");
  });

  it("rejects transition with wrong current state", () => {
    const result = transition(machine, "approved", "submit");
    expect(result.allowed).toBe(false);
    expect(result.from).toBe("approved");
    expect(result.reason).toContain("No transition");
  });

  it("rejects transition with unknown action", () => {
    const result = transition(machine, "draft", "fly");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("No transition");
  });

  it("rejects transition from an invalid state", () => {
    const result = transition(machine, "nonexistent", "submit");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Invalid current state");
  });

  it("supports multi-source transitions", () => {
    // cancel is valid from both draft and submitted
    const fromDraft = transition(machine, "draft", "cancel");
    expect(fromDraft.allowed).toBe(true);
    expect(fromDraft.to).toBe("cancelled");

    const fromSubmitted = transition(machine, "submitted", "cancel");
    expect(fromSubmitted.allowed).toBe(true);
    expect(fromSubmitted.to).toBe("cancelled");

    // cancel is NOT valid from approved
    const fromApproved = transition(machine, "approved", "cancel");
    expect(fromApproved.allowed).toBe(false);
  });

  it("handles chain of transitions", () => {
    let state = "draft";

    const r1 = transition(machine, state, "submit");
    expect(r1.allowed).toBe(true);
    state = r1.to ?? state;

    const r2 = transition(machine, state, "reject");
    expect(r2.allowed).toBe(true);
    state = r2.to ?? state;

    const r3 = transition(machine, state, "revise");
    expect(r3.allowed).toBe(true);
    expect(r3.to).toBe("draft");
  });
});

describe("canTransition", () => {
  const machine = createStateMachine(orderDefinition);

  it("returns true for a valid transition", () => {
    expect(canTransition(machine, "draft", "submit")).toBe(true);
  });

  it("returns false for an invalid transition", () => {
    expect(canTransition(machine, "approved", "submit")).toBe(false);
  });

  it("returns false for an unknown action", () => {
    expect(canTransition(machine, "draft", "teleport")).toBe(false);
  });

  it("returns false for an invalid current state", () => {
    expect(canTransition(machine, "nonexistent", "submit")).toBe(false);
  });

  it("returns true for multi-source transition from any valid source", () => {
    expect(canTransition(machine, "draft", "cancel")).toBe(true);
    expect(canTransition(machine, "submitted", "cancel")).toBe(true);
  });
});

describe("getAvailableActions", () => {
  const machine = createStateMachine(orderDefinition);

  it("returns all valid actions from a state", () => {
    const actions = getAvailableActions(machine, "draft");
    expect(actions).toContain("submit");
    expect(actions).toContain("cancel");
    expect(actions).toHaveLength(2);
  });

  it("returns actions for submitted state", () => {
    const actions = getAvailableActions(machine, "submitted");
    expect(actions).toContain("approve");
    expect(actions).toContain("reject");
    expect(actions).toContain("cancel");
    expect(actions).toHaveLength(3);
  });

  it("returns empty array for a terminal state", () => {
    const actions = getAvailableActions(machine, "approved");
    expect(actions).toEqual([]);
  });

  it("returns empty array for an unknown state", () => {
    const actions = getAvailableActions(machine, "nonexistent");
    expect(actions).toEqual([]);
  });

  it("returns empty array for a single-state machine with no transitions", () => {
    const machine = createStateMachine(singleStateDefinition);
    const actions = getAvailableActions(machine, "active");
    expect(actions).toEqual([]);
  });

  it("does not return duplicate actions", () => {
    // Even if multiple transitions share an action name, it should appear once
    const def: StateDefinition = {
      name: "test",
      schema: "Test",
      field: "status",
      initial: "a",
      states: ["a", "b", "c"],
      transitions: [
        { from: "a", to: "b", action: "go" },
        { from: "a", to: "c", action: "go" },
      ],
    };
    const m = createStateMachine(def);
    const actions = getAvailableActions(m, "a");
    expect(actions).toEqual(["go"]);
  });
});
