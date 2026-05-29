import { describe, expect, it } from "bun:test";
import { validatePhase1, validateProposal } from "../src/server-entry";
import { baseProposalOptions, createTestEngine } from "./helpers/proposal-fixtures";

describe("validatePhase1 duplicate detection", () => {
  it("fails when two changes target the same name and type", () => {
    const result = validatePhase1({
      changes: [
        {
          target: "entity",
          operation: "create",
          name: "order",
          definition: {
            name: "order",
            fields: { title: { type: "string", label: "Title" } },
          },
        },
        {
          target: "entity",
          operation: "update",
          name: "order",
          definition: {
            name: "order",
            fields: {
              title: { type: "string", label: "Title" },
              amount: { type: "number", label: "Amount" },
            },
          },
        },
      ],
    });

    expect(result.status).toBe("failed");
    expect(result.errors.some((e) => e.code === "DUPLICATE_CHANGE")).toBe(true);
    expect(result.errors.find((e) => e.code === "DUPLICATE_CHANGE")?.message).toContain(
      "entity 'order' appears multiple times",
    );
  });

  it("allows same name on different targets", () => {
    const result = validatePhase1({
      changes: [
        {
          target: "entity",
          operation: "create",
          name: "order",
          definition: {
            name: "order",
            fields: { title: { type: "string", label: "Title" } },
          },
        },
        {
          target: "action",
          operation: "create",
          name: "order",
          definition: {
            name: "order",
            entity: "order",
            label: "Order",
            policy: { mode: "sync", transaction: true },
          },
        },
      ],
    });

    expect(result.errors.filter((e) => e.code === "DUPLICATE_CHANGE")).toHaveLength(0);
  });
});

describe("validatePhase1 dead-end state detection", () => {
  it("warns about dead-end states (incoming but no outgoing transitions)", () => {
    const result = validatePhase1({
      changes: [
        {
          target: "entity",
          operation: "create",
          name: "ticket",
          definition: {
            name: "ticket",
            fields: { title: { type: "string", label: "Title" } },
          },
        },
        {
          target: "state",
          operation: "create",
          name: "ticket_lifecycle",
          definition: {
            name: "ticket_lifecycle",
            entity: "ticket",
            field: "status",
            initial: "open",
            states: ["open", "in_progress", "closed"],
            transitions: [
              { from: "open", to: "in_progress", action: "start" },
              { from: "in_progress", to: "closed", action: "close" },
              // "closed" is a dead-end: has incoming but no outgoing
            ],
          },
        },
      ],
    });

    expect(result.warnings.some((w) => w.code === "STATE_DEAD_END")).toBe(true);
    expect(result.warnings.find((w) => w.code === "STATE_DEAD_END")?.message).toContain('"closed"');
  });

  it("does not warn about dead-end for initial state with no outgoing", () => {
    // If initial state has no transitions at all, there are no transitions period,
    // so the dead-end check is inside the transitions block and won't trigger.
    const result = validatePhase1({
      changes: [
        {
          target: "entity",
          operation: "create",
          name: "simple",
          definition: {
            name: "simple",
            fields: { title: { type: "string", label: "Title" } },
          },
        },
        {
          target: "state",
          operation: "create",
          name: "simple_state",
          definition: {
            name: "simple_state",
            entity: "simple",
            field: "status",
            initial: "active",
            states: ["active"],
            transitions: [],
          },
        },
      ],
    });

    expect(result.warnings.filter((w) => w.code === "STATE_DEAD_END")).toHaveLength(0);
  });
});

describe("validatePhase1: stateTransition against state machine", () => {
  it("fails when stateTransition.from references invalid state", () => {
    const result = validatePhase1({
      changes: [
        {
          target: "entity",
          operation: "create",
          name: "order",
          definition: {
            name: "order",
            fields: { title: { type: "string", label: "Title" } },
          },
        },
        {
          target: "state",
          operation: "create",
          name: "order_lifecycle",
          definition: {
            name: "order_lifecycle",
            entity: "order",
            field: "status",
            initial: "draft",
            states: ["draft", "confirmed", "done"],
            transitions: [
              { from: "draft", to: "confirmed", action: "confirm" },
              { from: "confirmed", to: "done", action: "complete" },
            ],
          },
        },
        {
          target: "action",
          operation: "create",
          name: "confirm_order",
          definition: {
            name: "confirm_order",
            entity: "order",
            label: "Confirm Order",
            policy: { mode: "sync", transaction: true },
            stateTransition: { from: "nonexistent", to: "confirmed" },
          },
        },
      ],
    });

    expect(result.status).toBe("failed");
    expect(result.errors.some((e) => e.code === "TRANSITION_INVALID_STATE")).toBe(true);
    expect(result.errors.find((e) => e.code === "TRANSITION_INVALID_STATE")?.message).toContain(
      "'nonexistent'",
    );
  });

  it("fails when stateTransition.to references invalid state", () => {
    const result = validatePhase1({
      changes: [
        {
          target: "entity",
          operation: "create",
          name: "order",
          definition: {
            name: "order",
            fields: { title: { type: "string", label: "Title" } },
          },
        },
        {
          target: "state",
          operation: "create",
          name: "order_lifecycle",
          definition: {
            name: "order_lifecycle",
            entity: "order",
            field: "status",
            initial: "draft",
            states: ["draft", "confirmed"],
            transitions: [{ from: "draft", to: "confirmed", action: "confirm" }],
          },
        },
        {
          target: "action",
          operation: "create",
          name: "ship_order",
          definition: {
            name: "ship_order",
            entity: "order",
            label: "Ship Order",
            policy: { mode: "sync", transaction: true },
            stateTransition: { from: "confirmed", to: "shipped" },
          },
        },
      ],
    });

    expect(result.status).toBe("failed");
    expect(result.errors.some((e) => e.code === "TRANSITION_INVALID_STATE")).toBe(true);
    expect(result.errors.find((e) => e.code === "TRANSITION_INVALID_STATE")?.message).toContain(
      "'shipped'",
    );
  });

  it("passes when stateTransition references valid states", () => {
    const result = validatePhase1({
      changes: [
        {
          target: "entity",
          operation: "create",
          name: "order",
          definition: {
            name: "order",
            fields: { title: { type: "string", label: "Title" } },
          },
        },
        {
          target: "state",
          operation: "create",
          name: "order_lifecycle",
          definition: {
            name: "order_lifecycle",
            entity: "order",
            field: "status",
            initial: "draft",
            states: ["draft", "confirmed"],
            transitions: [{ from: "draft", to: "confirmed", action: "confirm" }],
          },
        },
        {
          target: "action",
          operation: "create",
          name: "confirm_order",
          definition: {
            name: "confirm_order",
            entity: "order",
            label: "Confirm Order",
            policy: { mode: "sync", transaction: true },
            stateTransition: { from: "draft", to: "confirmed" },
          },
        },
      ],
    });

    expect(result.errors.filter((e) => e.code === "TRANSITION_INVALID_STATE")).toHaveLength(0);
  });
});

describe("validateProposal: skipped phases don't block passed", () => {
  it("passes when Phase 1 passes and other phases are skipped", () => {
    const engine = createTestEngine();
    const proposal = engine.createProposal(baseProposalOptions);

    const result = validateProposal({ proposal });

    expect(result.passed).toBe(true);
    expect(result.phases[0].status).toBe("passed");
    expect(result.phases[1].status).toBe("skipped");
    expect(result.phases[2].status).toBe("skipped");
    expect(result.phases[3].status).toBe("skipped");
  });

  it("fails when Phase 1 fails even though other phases are skipped", () => {
    const engine = createTestEngine();
    const proposal = engine.createProposal({
      ...baseProposalOptions,
      changes: [
        {
          target: "entity",
          operation: "create",
          name: "empty",
          definition: { name: "empty", fields: {} },
        },
      ],
    });

    const result = validateProposal({ proposal });

    expect(result.passed).toBe(false);
    expect(result.phases[0].status).toBe("failed");
  });
});

describe("validatePhase1: required field without default is error", () => {
  it("reports an error for required field without default", () => {
    const result = validatePhase1({
      changes: [
        {
          target: "entity",
          operation: "create",
          name: "product",
          definition: {
            name: "product",
            fields: {
              name: { type: "string", required: true, label: "Name" },
            },
          },
        },
      ],
    });

    expect(result.status).toBe("failed");
    expect(result.errors.some((e) => e.code === "REQUIRED_NO_DEFAULT")).toBe(true);
  });

  it("does not error for required field with a default value", () => {
    const result = validatePhase1({
      changes: [
        {
          target: "entity",
          operation: "create",
          name: "product",
          definition: {
            name: "product",
            fields: {
              name: { type: "string", required: true, default: "Untitled", label: "Name" },
            },
          },
        },
      ],
    });

    expect(result.errors.filter((e) => e.code === "REQUIRED_NO_DEFAULT")).toHaveLength(0);
  });

  it("does not error for computed required fields without default", () => {
    const result = validatePhase1({
      changes: [
        {
          target: "entity",
          operation: "create",
          name: "product",
          definition: {
            name: "product",
            fields: {
              total: { type: "computed", required: true, label: "Total" },
            },
          },
        },
      ],
    });

    expect(result.errors.filter((e) => e.code === "REQUIRED_NO_DEFAULT")).toHaveLength(0);
  });
});
