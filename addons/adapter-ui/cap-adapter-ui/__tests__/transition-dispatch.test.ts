/**
 * Tests for the shared transition dispatch (lib/transition-dispatch.ts).
 *
 * Regression coverage for the state-transition bypass bug on the transition
 * pills (transition-buttons.tsx) and kanban drag-to-column (auto-kanban.tsx)
 * surfaces: both used to call the generic `transitionRecord` GraphQL mutation
 * unconditionally — a bare status update that skipped the bound Action, so
 * `setFields` stamps were never written and flows triggered on the action
 * never fired. Same bug class fixed for header buttons in PR #536
 * (entity-form-actions.test.ts).
 *
 * Dispatch must run the bound Action via `executeAction` when the transition
 * declares one; `transitionRecord` remains valid ONLY when no action is
 * bound. Exercised through the injected `TransitionDispatchApi` — never via
 * `globalThis.fetch` mocks (known batched-CI skew).
 */

import { describe, expect, test } from "bun:test";
import type { Transition } from "@linchkit/core/types";
import {
  executeTransition,
  resolveBoundAction,
  type TransitionDispatchApi,
} from "../src/lib/transition-dispatch";

// ── Injected-API capture helper ─────────────────────────────

interface ApiCalls {
  executeAction: { actionName: string; input: Record<string, unknown> }[];
  transitionRecord: { schema: string; id: string; to: string; fields: string[] }[];
  queryRecord: { schema: string; id: string; fields: string[] }[];
}

function makeApi(opts: {
  actionSuccess?: boolean;
  actionErrorMessage?: string;
  record?: Record<string, unknown> | null;
  queryThrows?: boolean;
  transitionResult?: Record<string, unknown>;
}): { api: TransitionDispatchApi; calls: ApiCalls } {
  const calls: ApiCalls = { executeAction: [], transitionRecord: [], queryRecord: [] };
  const api: TransitionDispatchApi = {
    executeAction: async (actionName, input) => {
      calls.executeAction.push({ actionName, input });
      const success = opts.actionSuccess ?? true;
      return success
        ? { success: true }
        : { success: false, error: { message: opts.actionErrorMessage } };
    },
    transitionRecord: async (schema, id, to, fields) => {
      calls.transitionRecord.push({ schema, id, to, fields });
      return opts.transitionResult ?? { id, status: to };
    },
    queryRecord: async (schema, id, fields) => {
      calls.queryRecord.push({ schema, id, fields });
      if (opts.queryThrows) throw new Error("network down");
      return opts.record ?? null;
    },
  };
  return { api, calls };
}

const BASE = {
  entityName: "purchase_request",
  recordId: "rec-1",
  to: "pending",
  recordFields: ["id", "status", "submitted_at"],
};

// ── executeTransition — bound action path ───────────────────

describe("executeTransition — transition with a bound Action", () => {
  test("runs the bound Action via executeAction, NEVER the generic transition mutation", async () => {
    const fresh = { id: "rec-1", status: "pending", submitted_at: "2026-06-10T00:00:00Z" };
    const { api, calls } = makeApi({ record: fresh });

    const outcome = await executeTransition({
      ...BASE,
      boundAction: "submit_purchase_request",
      api,
    });

    // The Action itself executes — server performs the declarative
    // stateTransition, stamps setFields, fires rules/flows.
    expect(calls.executeAction).toHaveLength(1);
    expect(calls.executeAction[0]).toEqual({
      actionName: "submit_purchase_request",
      input: { id: "rec-1" },
    });
    expect(calls.transitionRecord).toHaveLength(0);
    expect(outcome).toEqual({ kind: "success", updated: fresh });
  });

  test("re-queries the fresh record after the action so callers refresh in place", async () => {
    const { api, calls } = makeApi({ record: { id: "rec-1", status: "pending" } });

    await executeTransition({ ...BASE, boundAction: "submit_purchase_request", api });

    expect(calls.queryRecord).toHaveLength(1);
    expect(calls.queryRecord[0]).toEqual({
      schema: "purchase_request",
      id: "rec-1",
      fields: ["id", "status", "submitted_at"],
    });
  });

  test("action failure reports failed with the server message and skips the re-query", async () => {
    const { api, calls } = makeApi({
      actionSuccess: false,
      actionErrorMessage: "guard rejected",
    });

    const outcome = await executeTransition({
      ...BASE,
      boundAction: "submit_purchase_request",
      api,
    });

    expect(outcome).toEqual({ kind: "failed", message: "guard rejected" });
    expect(calls.queryRecord).toHaveLength(0);
    expect(calls.transitionRecord).toHaveLength(0);
  });

  test("re-query failure still reports success with updated: null (caller falls back to full refetch)", async () => {
    const { api } = makeApi({ queryThrows: true });

    const outcome = await executeTransition({
      ...BASE,
      boundAction: "submit_purchase_request",
      api,
    });

    expect(outcome).toEqual({ kind: "success", updated: null });
  });
});

// ── executeTransition — raw fallback path ───────────────────

describe("executeTransition — transition WITHOUT a bound Action", () => {
  test("falls back to the generic transition mutation and returns its record", async () => {
    const mutationResult = { id: "rec-1", status: "pending" };
    const { api, calls } = makeApi({ transitionResult: mutationResult });

    const outcome = await executeTransition({ ...BASE, boundAction: undefined, api });

    expect(calls.transitionRecord).toHaveLength(1);
    expect(calls.transitionRecord[0]).toEqual({
      schema: "purchase_request",
      id: "rec-1",
      to: "pending",
      fields: ["id", "status", "submitted_at"],
    });
    expect(calls.executeAction).toHaveLength(0);
    expect(calls.queryRecord).toHaveLength(0);
    expect(outcome).toEqual({ kind: "success", updated: mutationResult });
  });
});

// ── resolveBoundAction (kanban edge resolution) ─────────────

describe("resolveBoundAction", () => {
  const transitions: Transition[] = [
    { from: "draft", to: "pending", action: "submit_purchase_request" },
    { from: ["pending", "draft"], to: "cancelled", action: "cancel_purchase_request" },
    { from: "pending", to: "approved", action: "" },
  ];

  test("resolves the action bound to a single-from edge", () => {
    expect(resolveBoundAction(transitions, "draft", "pending")).toBe("submit_purchase_request");
  });

  test("resolves the action bound to an array-from edge", () => {
    expect(resolveBoundAction(transitions, "pending", "cancelled")).toBe("cancel_purchase_request");
    expect(resolveBoundAction(transitions, "draft", "cancelled")).toBe("cancel_purchase_request");
  });

  test("returns undefined when no edge matches (raw fallback)", () => {
    expect(resolveBoundAction(transitions, "approved", "draft")).toBeUndefined();
  });

  test("returns undefined when the edge declares an empty action name (raw fallback)", () => {
    expect(resolveBoundAction(transitions, "pending", "approved")).toBeUndefined();
  });
});
