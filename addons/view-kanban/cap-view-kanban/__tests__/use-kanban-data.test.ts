/**
 * Tests for the headless helpers powering KanbanBoard.
 *
 * These are pure-function tests — no DOM, no React. They cover the
 * meaningful behaviour of the kanban view: grouping, column ordering,
 * transition indexing, and drop validation against the state machine.
 */

import { describe, expect, test } from "bun:test";
import type { StateDefinition } from "@linchkit/core/types";
import {
  groupRecordsByState,
  indexTransitions,
  orderColumns,
  validateDrop,
} from "../src/use-kanban-data";

const stateDef: StateDefinition = {
  name: "purchase_request_state",
  entity: "purchase_request",
  field: "status",
  initial: "draft",
  states: ["draft", "submitted", "approved", "rejected"],
  transitions: [
    { from: "draft", to: "submitted", action: "submit_request" },
    { from: "submitted", to: "approved", action: "approve_request" },
    { from: "submitted", to: "rejected", action: "reject_request" },
    { from: ["approved", "rejected"], to: "draft", action: "reopen_request" },
  ],
  meta: {
    draft: { label: "Draft" },
    submitted: { label: "Submitted" },
    approved: { label: "Approved" },
    rejected: { label: "Rejected" },
  },
};

describe("groupRecordsByState", () => {
  test("initialises an empty bucket for every declared state", () => {
    const groups = groupRecordsByState([], stateDef, "status");
    expect([...groups.keys()]).toEqual(["draft", "submitted", "approved", "rejected"]);
    for (const value of groups.values()) {
      expect(value).toEqual([]);
    }
  });

  test("routes records into the column matching their state field", () => {
    const groups = groupRecordsByState(
      [
        { id: "r1", status: "draft" },
        { id: "r2", status: "submitted" },
        { id: "r3", status: "submitted" },
        { id: "r4", status: "approved" },
      ],
      stateDef,
      "status",
    );
    expect(groups.get("draft")?.map((r) => r.id)).toEqual(["r1"]);
    expect(groups.get("submitted")?.map((r) => r.id)).toEqual(["r2", "r3"]);
    expect(groups.get("approved")?.map((r) => r.id)).toEqual(["r4"]);
    expect(groups.get("rejected")?.map((r) => r.id)).toEqual([]);
  });

  test("falls back to the machine's initial state when the record field is empty", () => {
    const groups = groupRecordsByState(
      [
        { id: "r1", status: null },
        { id: "r2", status: undefined },
        { id: "r3", status: "" },
      ],
      stateDef,
      "status",
    );
    expect(groups.get("draft")?.map((r) => r.id)).toEqual(["r1", "r2", "r3"]);
  });

  test("surfaces records with unknown states in their own bucket", () => {
    const groups = groupRecordsByState(
      [{ id: "r1", status: "legacy_archived" }],
      stateDef,
      "status",
    );
    expect(groups.get("legacy_archived")?.map((r) => r.id)).toEqual(["r1"]);
    // Declared columns remain present so the board's shape doesn't collapse.
    expect(groups.get("draft")).toEqual([]);
  });
});

describe("orderColumns", () => {
  test("returns declared states first, then any drift columns", () => {
    const groups = groupRecordsByState(
      [
        { id: "r1", status: "draft" },
        { id: "r2", status: "legacy_archived" },
      ],
      stateDef,
      "status",
    );
    expect(orderColumns(stateDef, groups)).toEqual([
      "draft",
      "submitted",
      "approved",
      "rejected",
      "legacy_archived",
    ]);
  });

  test("preserves declared order when no drift exists", () => {
    const groups = groupRecordsByState([], stateDef, "status");
    expect(orderColumns(stateDef, groups)).toEqual(stateDef.states);
  });
});

describe("indexTransitions", () => {
  test("indexes single-from transitions", () => {
    const index = indexTransitions(stateDef.transitions);
    expect(index.get("draft")).toEqual(new Set(["submitted"]));
    expect(index.get("submitted")).toEqual(new Set(["approved", "rejected"]));
  });

  test("expands array-of-from transitions", () => {
    const index = indexTransitions(stateDef.transitions);
    expect(index.get("approved")).toEqual(new Set(["draft"]));
    expect(index.get("rejected")).toEqual(new Set(["draft"]));
  });

  test("does not index states with no outbound transitions", () => {
    const index = indexTransitions([{ from: "a", to: "b", action: "go" }]);
    expect(index.has("b")).toBe(false);
  });
});

describe("validateDrop", () => {
  const transitionsIndex = indexTransitions(stateDef.transitions);

  test("allows declared transitions", () => {
    expect(validateDrop({ fromState: "draft", toState: "submitted", transitionsIndex })).toEqual({
      allowed: true,
    });
  });

  test("rejects drops onto the source column as same-column", () => {
    const result = validateDrop({
      fromState: "submitted",
      toState: "submitted",
      transitionsIndex,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("same-column");
  });

  test("rejects transitions the state machine does not declare", () => {
    const result = validateDrop({
      fromState: "draft",
      toState: "approved",
      transitionsIndex,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("no-transition");
  });

  test("reports missing-state when the source state cannot be resolved", () => {
    const result = validateDrop({
      fromState: undefined,
      toState: "approved",
      transitionsIndex,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("missing-state");
  });
});
