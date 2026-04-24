/**
 * Field-lock enforcement (Spec 63 Phase 1).
 *
 * Runs on update actions and reports violations for:
 *  1. `immutable: true` (and the deprecated `readonly: true` alias) — the
 *     field cannot change once it has been set to a non-null value.
 *  2. `lockWhen` (per-field) and `lockAllWhen` + `lockAllowFields`
 *     (entity-wide) — conditional readonly based on the existing record's
 *     state. Per-field `lockWhen` always wins; `lockAllowFields` exempts a
 *     field from `lockAllWhen` only.
 *
 * Fields absent from the supplied `fields` map are ignored — other layers
 * (input validation, write-time column filter) handle unknown fields.
 *
 * ### Pre-flight coverage
 *
 * The engine calls this checker in Step 4b with the _effective write set_
 * it can predict from the action definition:
 *  - Caller `input` (minus `id`)
 *  - Resolved `action.setFields` values (after `$`-expression resolution)
 *
 * Fields written inside an `action.handler` via `ctx.update(...)` /
 * `ctx.create(...)` are NOT visible pre-flight and therefore are NOT
 * lock-checked. Declarative actions (those that rely on `setFields` and/or
 * `stateTransition`) ARE fully covered. Handler-based actions are responsible
 * for their own lock compliance (or should be migrated to declarative form).
 */

import type { FieldDefinition, LockCondition } from "../types/entity";

export type FieldLockViolationType = "immutable" | "locked";

export interface FieldLockViolation {
  /** Field name that violated a lock rule */
  field: string;
  /** Which rule was violated */
  type: FieldLockViolationType;
  /** For `locked` violations: the lock condition that triggered the block */
  condition?: LockCondition;
  /** Human-readable violation message */
  message: string;
}

/**
 * Structural equality for JSON-serializable values. Unlike a JSON.stringify
 * round-trip, ignores object key order so `{a:1,b:2}` === `{b:2,a:1}`
 * reorderings don't raise false "value changed" violations.
 *
 * Handles primitives, arrays, and plain objects. Field constraints do not
 * allow Dates, Maps, class instances, or cyclic structures (see
 * FieldDefinition types), so those cases need not be considered.
 */
function structuralEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  const ta = typeof a;
  const tb = typeof b;
  if (ta !== tb) return false;
  if (ta !== "object") return false;
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr && bArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!structuralEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao);
  const bKeys = Object.keys(bo);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.hasOwn(bo, k)) return false;
    if (!structuralEqual(ao[k], bo[k])) return false;
  }
  return true;
}

export interface FieldLockCheckArgs {
  /**
   * Resolved field definitions — must include inherited, interface-injected,
   * and overridden fields. Callers should normally pass the `.definition` of
   * each {@link import("../types/entity").ResolvedField} so overlays and
   * inherited immutable/lockWhen flags are honored.
   */
  fields: Record<string, FieldDefinition>;
  /**
   * Entity-level lock condition from `ResolvedEntity.source.lockAllWhen`.
   * Not inherited by child entities (a deliberate Phase 1 scope decision).
   */
  lockAllWhen?: LockCondition;
  /** Fields exempt from {@link lockAllWhen}. */
  lockAllowFields?: string[];
  existingRecord: Record<string, unknown>;
  /**
   * Effective write set. The engine combines caller `input` with resolved
   * `action.setFields` and omits state-transition `status` before calling.
   */
  input: Record<string, unknown>;
}

/**
 * Evaluate a {@link LockCondition} against the existing record.
 *
 * Phase 1 covers only `state` (string | string[] | {not}). Lock conditions
 * without `state` (e.g., future `domain`-only conditions) return `false` —
 * the engine is forward-compatible: new fields without a Phase 1 handler
 * act as no-ops rather than throwing.
 */
export function matchesLockCondition(
  record: Record<string, unknown>,
  condition: LockCondition,
): boolean {
  if (condition.state !== undefined) {
    const status = record.status as string | undefined;
    const spec = condition.state;
    if (typeof spec === "string") {
      return status === spec;
    }
    if (Array.isArray(spec)) {
      return status !== undefined && spec.includes(status);
    }
    // { not: ... } — lock when status is none of the excluded values.
    // `status === undefined` means "no status set" which we treat as
    // NOT matching `not: x` (can't exclude what isn't there) to avoid
    // false positives on records that don't use a status field at all.
    const excluded = spec.not;
    const excludedArr = typeof excluded === "string" ? [excluded] : excluded;
    return status !== undefined && !excludedArr.includes(status);
  }
  // Phase 1: `domain` is reserved. Any condition lacking a `state` clause
  // is treated as a no-op until Phase 2 implements domain evaluation.
  return false;
}

/**
 * Return all field-lock violations for the given update input.
 *
 * - Immutable is checked first; if a field both violates immutable AND
 *   matches a lock condition, only the immutable violation is reported
 *   (immutable is the more specific, permanent rule).
 * - Fields missing from `args.fields` are silently ignored.
 */
export function checkFieldLocks(args: FieldLockCheckArgs): FieldLockViolation[] {
  const violations: FieldLockViolation[] = [];
  const { fields, lockAllWhen, lockAllowFields, existingRecord, input } = args;

  for (const [fieldName, newValue] of Object.entries(input)) {
    const field = fields[fieldName];
    if (!field) continue;

    const existing = existingRecord[fieldName];

    // Same-value re-writes are no-ops everywhere in this checker. A common
    // UI pattern sends the full record on update — locked fields that are
    // echoed back unchanged must not raise violations. Use structural
    // equality so reordered object keys ({a:1,b:2} vs {b:2,a:1}) don't
    // trigger false positives.
    const unchanged = structuralEqual(existing, newValue);

    // 1. Immutable (or deprecated `readonly` alias) — only enforced once the
    //    field has a non-null existing value. First-write (existing == null)
    //    is always allowed, including the transition null -> value.
    const isImmutable = field.immutable === true || field.readonly === true;
    if (isImmutable && existing != null && !unchanged) {
      violations.push({
        field: fieldName,
        type: "immutable",
        message: `Field "${fieldName}" is immutable and cannot be modified`,
      });
      // Don't also report this field as locked — immutable is more specific.
      continue;
    }

    // 2. Per-field `lockWhen` beats entity-level `lockAllWhen`.
    //    `lockAllowFields` exempts a field from `lockAllWhen` only — it does
    //    NOT bypass an explicit per-field `lockWhen` on the same field.
    //    Same-value re-writes are not violations (same principle as immutable).
    const lockCondition: LockCondition | undefined =
      field.lockWhen ?? (lockAllowFields?.includes(fieldName) ? undefined : lockAllWhen);

    if (lockCondition && !unchanged && matchesLockCondition(existingRecord, lockCondition)) {
      const statusMsg =
        typeof existingRecord.status === "string" ? ` in state "${existingRecord.status}"` : "";
      violations.push({
        field: fieldName,
        type: "locked",
        condition: lockCondition,
        message: `Field "${fieldName}" is locked${statusMsg}`,
      });
    }
  }

  return violations;
}
