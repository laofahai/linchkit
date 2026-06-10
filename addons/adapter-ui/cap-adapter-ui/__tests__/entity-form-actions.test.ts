/**
 * Tests for the entity-form header-action dispatch (executeHeaderAction).
 *
 * Regression coverage for the state-transition bypass bug: clicking a header
 * button whose action is bound to a state transition (e.g.
 * `submit_purchase_request` with `stateTransition: { from: "draft", to:
 * "pending" }`) used to call the generic `transitionRecord` GraphQL mutation —
 * a bare status update that skipped the Action entirely, so `setFields` stamps
 * (`submitted_at`) were never written and flows triggered on the action never
 * fired. The dispatch must run the bound Action via `executeAction`; the
 * server-side action performs the declarative transition itself.
 *
 * This package's test setup is logic-only (no jsdom / happy-dom — see
 * action-proposal-card.test.ts), so `executeHeaderAction` is exercised through
 * its injected `HeaderActionApi` (same injection style as
 * field-lock-bypass.test.ts). The raw `transitionRecord` client (still the
 * path for transitions invoked WITHOUT a bound action — transition pills,
 * kanban drags) is unchanged by this fix and deliberately NOT covered here:
 * a `globalThis.fetch` swap passes in isolation but breaks under the batched
 * CI run (known skew — inject dependencies instead of mocking globals).
 */

import { describe, expect, test } from "bun:test";

// Minimal localStorage shim — the api wrappers read `linchkit:token` for auth.
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

import {
  executeHeaderAction,
  type HeaderActionApi,
  type TransitionInfo,
} from "../src/pages/entity-form-actions";

// ── Injected-API capture helper ─────────────────────────────

interface ApiCalls {
  executeAction: { actionName: string; input: Record<string, unknown> }[];
  queryRecord: { schema: string; id: string; fields: string[] }[];
}

function makeApi(opts: {
  actionSuccess?: boolean;
  record?: Record<string, unknown> | null;
  queryThrows?: boolean;
}): { api: HeaderActionApi; calls: ApiCalls } {
  const calls: ApiCalls = { executeAction: [], queryRecord: [] };
  const api: HeaderActionApi = {
    executeAction: async (actionName, input) => {
      calls.executeAction.push({ actionName, input });
      return { success: opts.actionSuccess ?? true };
    },
    queryRecord: async (schema, id, fields) => {
      calls.queryRecord.push({ schema, id, fields });
      if (opts.queryThrows) throw new Error("network down");
      return opts.record ?? null;
    },
  };
  return { api, calls };
}

const TRANSITIONS: TransitionInfo[] = [
  { action: "submit_purchase_request", to: "pending" },
  { action: "approve_purchase_request", to: "approved" },
];

const BASE = {
  entityName: "purchase_request",
  recordId: "rec-1",
  recordFields: ["id", "status", "submitted_at"],
  availableTransitions: TRANSITIONS,
};

// ── executeHeaderAction ─────────────────────────────────────

describe("executeHeaderAction — transition-bound actions", () => {
  test("runs the bound Action via executeAction, NOT a generic status update", async () => {
    const { api, calls } = makeApi({ record: { id: "rec-1", status: "pending" } });

    const outcome = await executeHeaderAction({
      ...BASE,
      actionName: "submit_purchase_request",
      api,
    });

    // The Action itself executes — server performs the declarative
    // stateTransition, stamps setFields, fires rules/flows.
    expect(calls.executeAction).toHaveLength(1);
    expect(calls.executeAction[0]).toEqual({
      actionName: "submit_purchase_request",
      input: { id: "rec-1" },
    });
    expect(outcome.kind).toBe("transition_success");
  });

  test("re-queries the fresh record on success and returns it for in-place form refresh", async () => {
    const fresh = { id: "rec-1", status: "pending", submitted_at: "2026-06-10T00:00:00Z" };
    const { api, calls } = makeApi({ record: fresh });

    const outcome = await executeHeaderAction({
      ...BASE,
      actionName: "submit_purchase_request",
      api,
    });

    expect(calls.queryRecord).toHaveLength(1);
    expect(calls.queryRecord[0]).toEqual({
      schema: "purchase_request",
      id: "rec-1",
      fields: ["id", "status", "submitted_at"],
    });
    expect(outcome).toEqual({ kind: "transition_success", updated: fresh });
  });

  test("action failure reports failed and skips the record re-query", async () => {
    const { api, calls } = makeApi({ actionSuccess: false });

    const outcome = await executeHeaderAction({
      ...BASE,
      actionName: "approve_purchase_request",
      api,
    });

    expect(outcome).toEqual({ kind: "failed" });
    expect(calls.queryRecord).toHaveLength(0);
  });

  test("re-query failure still reports transition_success with updated: null (caller falls back to full refetch)", async () => {
    const { api } = makeApi({ queryThrows: true });

    const outcome = await executeHeaderAction({
      ...BASE,
      actionName: "submit_purchase_request",
      api,
    });

    expect(outcome).toEqual({ kind: "transition_success", updated: null });
  });
});

describe("executeHeaderAction — plain (non-transition) actions", () => {
  test("executes the action and never touches the record query", async () => {
    const { api, calls } = makeApi({});

    const outcome = await executeHeaderAction({
      ...BASE,
      actionName: "send_reminder",
      api,
    });

    expect(calls.executeAction).toHaveLength(1);
    expect(calls.executeAction[0]).toEqual({ actionName: "send_reminder", input: { id: "rec-1" } });
    expect(calls.queryRecord).toHaveLength(0);
    expect(outcome).toEqual({ kind: "action_success" });
  });

  test("failure surfaces as failed", async () => {
    const { api } = makeApi({ actionSuccess: false });

    const outcome = await executeHeaderAction({ ...BASE, actionName: "send_reminder", api });

    expect(outcome).toEqual({ kind: "failed" });
  });
});
