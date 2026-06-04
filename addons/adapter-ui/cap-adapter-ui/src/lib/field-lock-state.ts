/**
 * Field-lock state computation for the auto-form (Spec 63 §5.1 — UI integration).
 *
 * REUSES the authoritative lock semantics from `@linchkit/core`'s
 * `engine/field-lock-checker.ts`: it imports `matchesLockCondition` and
 * `SYSTEM_FIELD_NAMES` (both pure and browser-safe — the checker imports only
 * types) from the default `@linchkit/core` (client) barrel rather than mirroring
 * them. This module no longer re-declares the system-field set nor
 * re-implements the condition-matching predicate; the single source of truth is
 * core, removing the previous drift risk between the two copies.
 *
 * Two intentional differences from the engine, kept here for the UI's purpose:
 *  1. The engine answers "is this write-set legal?" (keyed on submitted
 *     `input`). The form needs "would this field be locked if the user tried
 *     to edit it?", independent of any pending value — so this module evaluates
 *     lock state per field, not per changed value.
 *  2. `immutable` only locks in EDIT mode. On CREATE the field is being set for
 *     the first time, which the engine always allows; locking it in the form
 *     would wrongly block the initial assignment.
 *
 * Everything else (per-field `lockWhen` beating entity-wide `lockAllWhen`,
 * `lockAllowFields` exemptions, the `SYSTEM_FIELD_NAMES` auto-exemption, and the
 * `state` condition semantics) is delegated to core's authoritative matcher.
 */

import { matchesLockCondition, SYSTEM_FIELD_NAMES } from "@linchkit/core";
import type { EntityDefinition, FieldDefinition, LockCondition } from "@linchkit/core/types";

// Re-export core's authoritative matcher so existing consumers (and tests) that
// imported it from this module keep resolving to the single source of truth.
export { matchesLockCondition };

/** Why a field is locked, for the UI lock indicator tooltip. */
export type FieldLockReason = "immutable" | "locked";

export interface FieldLockState {
  /** Whether the field should render readonly. */
  locked: boolean;
  /** Which rule locked it (only set when `locked` is true). */
  reason?: FieldLockReason;
  /**
   * Enforcement mode of the lock (only set when `locked`). `"hard"` blocks the
   * write; `"soft"` is advisory — the UI requires a two-step confirmation
   * before accepting the change (Spec 63 §4.2). `immutable` is always `"hard"`.
   */
  mode?: "hard" | "soft";
  /** For `locked` reason: the condition that matched (for tooltip detail). */
  condition?: LockCondition;
}

const UNLOCKED: FieldLockState = { locked: false };

export interface ComputeFieldLockStateArgs {
  fieldName: string;
  fieldDef: FieldDefinition;
  /** The current record values (status + field values being edited). */
  record: Record<string, unknown>;
  /** `true` on update, `false` on create — immutable only locks on update. */
  isEditMode: boolean;
  /** Entity-wide `lockAllWhen`. */
  lockAllWhen?: LockCondition;
  /** Fields exempt from `lockAllWhen`. */
  lockAllowFields?: string[];
}

/**
 * Compute the lock state for a single field.
 *
 * Precedence mirrors core's `checkFieldLocks`:
 *  1. `immutable` (or the deprecated `readonly` alias) — but ONLY in edit mode.
 *     Immutable blocks updates, not the initial create-time assignment.
 *  2. Per-field `lockWhen` beats entity-level `lockAllWhen`. `lockAllowFields`
 *     exempts a field from `lockAllWhen` only — it does NOT bypass an explicit
 *     per-field `lockWhen`. System fields (core's `SYSTEM_FIELD_NAMES`) are
 *     exempt from `lockAllWhen` unless they carry an explicit `lockWhen`.
 *
 * The condition matching itself is delegated to core's `matchesLockCondition`.
 */
export function computeFieldLockState(args: ComputeFieldLockStateArgs): FieldLockState {
  const { fieldName, fieldDef, record, isEditMode, lockAllWhen, lockAllowFields } = args;

  // 1. Immutable — edit mode only. The field already holds a committed value
  //    that the engine would refuse to change.
  const isImmutable = fieldDef.immutable === true || fieldDef.readonly === true;
  if (isEditMode && isImmutable) {
    // `immutable` is always hard — `lockMode` only governs conditional locks.
    return { locked: true, reason: "immutable", mode: "hard" };
  }

  // 2. Conditional lock. Per-field `lockWhen` wins; otherwise fall back to
  //    `lockAllWhen` unless the field is allow-listed or a system field. This
  //    is the same selection core's `checkFieldLocks` performs.
  const isSystemField = SYSTEM_FIELD_NAMES.has(fieldName);
  const lockCondition: LockCondition | undefined =
    fieldDef.lockWhen ??
    (lockAllowFields?.includes(fieldName) || isSystemField ? undefined : lockAllWhen);

  if (lockCondition && matchesLockCondition(record, lockCondition)) {
    // Conditional lock honors the field's `lockMode` (Spec 63 §4.2, default hard).
    return {
      locked: true,
      reason: "locked",
      mode: fieldDef.lockMode === "soft" ? "soft" : "hard",
      condition: lockCondition,
    };
  }

  return UNLOCKED;
}

export interface ComputeEntityLockStateArgs {
  entity: EntityDefinition;
  /** Field names to evaluate (typically the form's visible fields). */
  fieldNames: readonly string[];
  /** Current record values (status + edited field values). */
  record: Record<string, unknown>;
  /** `true` on update, `false` on create. */
  isEditMode: boolean;
}

/**
 * Compute lock state for every requested field, returning a map keyed by field
 * name. Fields absent from `entity.fields` are skipped (overlay/relation
 * synthetic fields aren't governed by entity-level lock rules).
 */
export function computeEntityLockState(
  args: ComputeEntityLockStateArgs,
): Record<string, FieldLockState> {
  const { entity, fieldNames, record, isEditMode } = args;
  const result: Record<string, FieldLockState> = {};
  for (const fieldName of fieldNames) {
    const fieldDef = entity.fields[fieldName];
    if (!fieldDef) continue;
    result[fieldName] = computeFieldLockState({
      fieldName,
      fieldDef,
      record,
      isEditMode,
      lockAllWhen: entity.lockAllWhen,
      lockAllowFields: entity.lockAllowFields,
    });
  }
  return result;
}
