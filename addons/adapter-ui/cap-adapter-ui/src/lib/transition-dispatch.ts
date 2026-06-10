/**
 * Shared state-transition dispatch for UI surfaces (transition pills, kanban
 * drag-to-column).
 *
 * A transition with a bound Action MUST run through the Action itself: the
 * server-side action performs the declarative `stateTransition`, stamps
 * `setFields`, and fires rules/flows (e.g. `submit_purchase_request` stamps
 * `submitted_at` and triggers the approval Flow). Routing it through the
 * generic `transitionRecord` mutation bypasses all of that — it degrades to a
 * bare status update. The generic mutation remains valid ONLY when no action
 * is bound to the transition.
 *
 * Same fix pattern as `executeHeaderAction` in pages/entity-form-actions.ts
 * (header buttons are keyed by action name; these surfaces are keyed by
 * target state, hence the bound-action resolution + raw fallback here).
 * Dependencies are injected (`TransitionDispatchApi`) so tests exercise the
 * dispatch without mocking globals.
 */

import type { Transition } from "@linchkit/core/types";

/** Minimal API surface consumed by executeTransition — injectable in tests. */
export interface TransitionDispatchApi {
  executeAction: (
    actionName: string,
    input: Record<string, unknown>,
  ) => Promise<{ success: boolean; error?: { message?: string } }>;
  transitionRecord: (
    schema: string,
    id: string,
    to: string,
    fields: string[],
  ) => Promise<Record<string, unknown>>;
  queryRecord: (
    schema: string,
    id: string,
    fields: string[],
  ) => Promise<Record<string, unknown> | null>;
}

/** Structured outcome; callers map it to toasts/refreshes. */
export type TransitionDispatchOutcome =
  | { kind: "success"; updated: Record<string, unknown> | null }
  | { kind: "failed"; message?: string };

/**
 * Resolve the Action bound to a state-machine transition edge (from → to).
 * Returns undefined when no edge matches or the edge declares no action
 * (empty action name) — callers then fall back to the raw transition mutation.
 */
export function resolveBoundAction(
  transitions: readonly Transition[],
  fromState: string,
  toState: string,
): string | undefined {
  for (const tr of transitions) {
    const fromArr = Array.isArray(tr.from) ? tr.from : [tr.from];
    if (fromArr.includes(fromState) && tr.to === toState) {
      return tr.action || undefined;
    }
  }
  return undefined;
}

/**
 * Execute a state transition: through its bound Action when one exists,
 * through the generic transition mutation otherwise.
 *
 * After a successful bound-action run the fresh record is re-queried (status,
 * `setFields` stamps, derived fields); `updated: null` means the re-query
 * failed and the caller should fall back to a full refetch. Network/GraphQL
 * errors from the raw transition path propagate to the caller (same contract
 * as calling `transitionRecord` directly).
 */
export async function executeTransition(opts: {
  entityName: string;
  recordId: string;
  to: string;
  /** Action bound to this transition; undefined → raw transition mutation. */
  boundAction: string | undefined;
  recordFields: string[];
  api: TransitionDispatchApi;
}): Promise<TransitionDispatchOutcome> {
  const { entityName, recordId, to, boundAction, recordFields, api } = opts;

  if (!boundAction) {
    // No bound action — the generic transition mutation is the correct path.
    const updated = await api.transitionRecord(entityName, recordId, to, recordFields);
    return { kind: "success", updated };
  }

  const result = await api.executeAction(boundAction, { id: recordId });
  if (!result.success) {
    return { kind: "failed", message: result.error?.message };
  }

  // Bound action succeeded — re-query the record so the caller can refresh
  // local state in place.
  let updated: Record<string, unknown> | null = null;
  try {
    updated = await api.queryRecord(entityName, recordId, recordFields);
  } catch {
    updated = null;
  }
  return { kind: "success", updated };
}
