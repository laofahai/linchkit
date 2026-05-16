/**
 * Headless helpers for KanbanBoard.
 *
 * Splitting the pure logic (column grouping, transition validation, the
 * default transition transport) into a single module keeps the React
 * component focused on rendering and lets us unit-test the meaningful
 * behaviour without a DOM. The component imports `useKanbanData` for the
 * memoised view of the records + state machine, and the test suite
 * imports the named helpers directly.
 */

import { transitionRecord } from "@linchkit/cap-adapter-ui/lib/api";
import type { StateDefinition, Transition } from "@linchkit/core/types";
import { useMemo } from "react";
import type { DropValidation, KanbanRecord, TransitionFn } from "./types";

/** Group records by state-field value. Initialises an empty bucket for every declared state. */
export function groupRecordsByState(
  records: ReadonlyArray<KanbanRecord>,
  stateDefinition: StateDefinition,
  stateField: string,
): Map<string, KanbanRecord[]> {
  const groups = new Map<string, KanbanRecord[]>();
  for (const state of stateDefinition.states) {
    groups.set(state, []);
  }
  for (const record of records) {
    const raw = record[stateField];
    const stateValue = raw == null || raw === "" ? stateDefinition.initial : String(raw);
    const bucket = groups.get(stateValue);
    if (bucket) {
      bucket.push(record);
    } else {
      // Records carrying a value not declared on the machine still need to
      // render somewhere — surface them in their own column so the user
      // sees the drift rather than silently dropping data.
      groups.set(stateValue, [record]);
    }
  }
  return groups;
}

/** Build the ordered column list — declared states first, then any extras encountered in `data`. */
export function orderColumns(
  stateDefinition: StateDefinition,
  groups: ReadonlyMap<string, ReadonlyArray<KanbanRecord>>,
): string[] {
  const ordered = [...stateDefinition.states];
  for (const key of groups.keys()) {
    if (!ordered.includes(key)) {
      ordered.push(key);
    }
  }
  return ordered;
}

/** Index transitions as `from -> Set<to>` for O(1) drop validation. */
export function indexTransitions(transitions: ReadonlyArray<Transition>): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const tr of transitions) {
    const fromList = Array.isArray(tr.from) ? tr.from : [tr.from];
    for (const from of fromList) {
      let targets = index.get(from);
      if (!targets) {
        targets = new Set<string>();
        index.set(from, targets);
      }
      targets.add(tr.to);
    }
  }
  return index;
}

/** Decide whether a drop from `fromState` to `toState` is permitted by the state machine. */
export function validateDrop(input: {
  fromState: string | undefined;
  toState: string;
  transitionsIndex: ReadonlyMap<string, ReadonlySet<string>>;
}): DropValidation {
  const { fromState, toState, transitionsIndex } = input;
  if (!fromState) return { allowed: false, reason: "missing-state" };
  if (fromState === toState) return { allowed: false, reason: "same-column" };
  const targets = transitionsIndex.get(fromState);
  if (!targets?.has(toState)) {
    return { allowed: false, reason: "no-transition" };
  }
  return { allowed: true };
}

/** Default transition transport — issues the GraphQL mutation via cap-adapter-ui. */
export const defaultTransition: TransitionFn = async ({ entity, recordId, to, fields }) => {
  const result = await transitionRecord<KanbanRecord>(entity, recordId, to, [...fields]);
  return result;
};

/** Memoised view of records + state machine for KanbanBoard. */
export interface UseKanbanDataResult {
  columnOrder: string[];
  groups: Map<string, KanbanRecord[]>;
  transitionsIndex: Map<string, Set<string>>;
}

export function useKanbanData(
  records: ReadonlyArray<KanbanRecord>,
  stateDefinition: StateDefinition,
  stateField: string,
): UseKanbanDataResult {
  return useMemo(() => {
    const groups = groupRecordsByState(records, stateDefinition, stateField);
    const columnOrder = orderColumns(stateDefinition, groups);
    const transitionsIndex = indexTransitions(stateDefinition.transitions);
    return { columnOrder, groups, transitionsIndex };
  }, [records, stateDefinition, stateField]);
}
