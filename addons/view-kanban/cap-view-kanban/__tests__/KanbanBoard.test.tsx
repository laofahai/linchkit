/**
 * KanbanBoard surface + transition-transport tests.
 *
 * The repo's existing UI test setup (cap-adapter-ui, cap-audit-ui) runs
 * without a DOM — see addons/adapter-ui/cap-adapter-ui/__tests__/ai-assistant.test.ts
 * for the precedent. Render-level tests are deferred until the repo gains
 * a happy-dom / jsdom harness. These tests therefore cover:
 *
 *  1. Public exports surface — KanbanBoard / KanbanColumn / KanbanCard are
 *     real React components, helpers are exported, capability metadata is
 *     consistent.
 *  2. Transition transport — `defaultTransition` forwards the
 *     entity / id / target state / fields tuple to the cap-adapter-ui
 *     GraphQL helper, which is the contract a drag-end fires against.
 *  3. End-to-end drop decision — given a state machine and a record, the
 *     same validation the board runs in `handleDragEnd` returns the
 *     expected go / no-go for each scenario the UI needs to handle.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { StateDefinition } from "@linchkit/core/types";

const transitionRecordMock = mock(
  async (_schema: string, _id: string, _to: string, _fields: string[]) => ({
    id: "stubbed",
  }),
);

const apiActual = await import("@linchkit/cap-adapter-ui/lib/api");
mock.module("@linchkit/cap-adapter-ui/lib/api", () => ({
  ...apiActual,
  transitionRecord: transitionRecordMock,
}));

const {
  KanbanBoard,
  KanbanColumn,
  KanbanCard,
  capViewKanban,
  defaultTransition,
  indexTransitions,
  validateDrop,
} = await import("../src/index");

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
  ],
};

beforeEach(() => {
  transitionRecordMock.mockClear();
});

afterEach(() => {
  transitionRecordMock.mockReset();
});

// ── 1. Public surface ───────────────────────────────────────

describe("cap-view-kanban exports", () => {
  test("exposes the React components as functions", () => {
    expect(typeof KanbanBoard).toBe("function");
    expect(typeof KanbanColumn).toBe("function");
    expect(typeof KanbanCard).toBe("function");
  });

  test("exposes the headless helpers", () => {
    expect(typeof defaultTransition).toBe("function");
    expect(typeof indexTransitions).toBe("function");
    expect(typeof validateDrop).toBe("function");
  });
});

describe("capViewKanban metadata", () => {
  test("declares the expected name, type, category, and autoInstall", () => {
    expect(capViewKanban.name).toBe("cap-view-kanban");
    expect(capViewKanban.type).toBe("standard");
    expect(capViewKanban.category).toBe("view");
    expect(capViewKanban.group).toBe("view-kanban");
    expect(capViewKanban.dependencies).toEqual(["cap-adapter-ui"]);
    expect(capViewKanban.autoInstall).toBe(false);
    expect(capViewKanban.version).toBe("0.1.0");
  });
});

// ── 2. Transition transport ─────────────────────────────────

describe("defaultTransition", () => {
  test("forwards the entity / id / target state / fields tuple to the GraphQL helper", async () => {
    transitionRecordMock.mockImplementationOnce(async () => ({
      id: "r-42",
      status: "submitted",
    }));

    const result = await defaultTransition({
      entity: "purchase_request",
      recordId: "r-42",
      to: "submitted",
      fields: ["id", "status", "updated_at"],
    });

    expect(transitionRecordMock).toHaveBeenCalledTimes(1);
    expect(transitionRecordMock.mock.calls[0]).toEqual([
      "purchase_request",
      "r-42",
      "submitted",
      ["id", "status", "updated_at"],
    ]);
    expect(result).toEqual({ id: "r-42", status: "submitted" });
  });

  test("rejects when the transport fails so handleDragEnd can surface the error", async () => {
    transitionRecordMock.mockImplementationOnce(async () => {
      throw new Error("network down");
    });

    await expect(
      defaultTransition({
        entity: "purchase_request",
        recordId: "r-1",
        to: "approved",
        fields: ["id"],
      }),
    ).rejects.toThrow("network down");
  });
});

// ── 3. Drop decision (the same path handleDragEnd runs) ─────

describe("KanbanBoard drag-end decision", () => {
  const transitionsIndex = indexTransitions(stateDef.transitions);

  test("accepts a draft → submitted drop, the declared happy path", () => {
    const decision = validateDrop({
      fromState: "draft",
      toState: "submitted",
      transitionsIndex,
    });
    expect(decision).toEqual({ allowed: true });
  });

  test("refuses a draft → approved drop (skipping submitted) — no-transition", () => {
    const decision = validateDrop({
      fromState: "draft",
      toState: "approved",
      transitionsIndex,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("no-transition");
  });

  test("refuses a drop back on the source column as same-column (no-op)", () => {
    const decision = validateDrop({
      fromState: "submitted",
      toState: "submitted",
      transitionsIndex,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("same-column");
  });
});
