/**
 * useFieldLockState — compute which auto-form fields are locked (Spec 63 §5.1).
 *
 * Given the entity definition, the current record values, and the form mode,
 * returns a memoized map of field name → {@link FieldLockState}. The auto-form
 * feeds `locked` into each field's existing `readonly` prop and renders a lock
 * indicator using `reason` / `condition`.
 *
 * The heavy lifting lives in the pure `computeEntityLockState` helper so the
 * lock semantics are testable without a React render harness.
 */

import type { EntityDefinition } from "@linchkit/core/types";
import { useMemo } from "react";
import { computeEntityLockState, type FieldLockState } from "../lib/field-lock-state";

export interface UseFieldLockStateArgs {
  /** The entity definition carrying field-level + entity-level lock rules. */
  entity: EntityDefinition;
  /** Field names to evaluate — typically the form's visible field names. */
  fieldNames: readonly string[];
  /** Current record values (must include `status` for state-based locks). */
  record: Record<string, unknown>;
  /** Form mode. `immutable` fields only lock on update, never on create. */
  mode: "create" | "edit" | "view";
}

export type FieldLockStateMap = Record<string, FieldLockState>;

/**
 * Returns a map of field name → lock state for the given entity + record.
 * `view` mode is treated like `edit` for immutable evaluation (the whole form
 * is already readonly there, but immutable fields are still semantically
 * locked rather than merely display-only).
 */
export function useFieldLockState({
  entity,
  fieldNames,
  record,
  mode,
}: UseFieldLockStateArgs): FieldLockStateMap {
  const isEditMode = mode !== "create";
  // Callers pass a memoized `fieldNames` (stable identity across renders), so
  // depending on it directly recomputes only when the field set or record
  // values actually change.
  return useMemo(
    () => computeEntityLockState({ entity, fieldNames, record, isEditMode }),
    [entity, fieldNames, record, isEditMode],
  );
}
