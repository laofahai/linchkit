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
 * ### Where the checker fires
 *
 * The engine invokes this checker from two points:
 *
 *  1. **Step 4b (declarative-update path)** — when `action.setFields` or
 *     `action.stateTransition` is declared. The executor knows the exact
 *     write set statically (resolved setFields − status on transition) and
 *     can pre-flight it before any handler runs.
 *  2. **`ctx.update()` wrapper (handler path)** — handler-based actions call
 *     `ctx.update(entity, id, data)` at some point during execution; the
 *     wrapper inspects the exact data argument (what will hit the DB) and
 *     runs the check against a fresh read of the current record. Checking
 *     handler-internal writes at the moment of `ctx.update` means
 *     handler-computed writes (e.g., `ctx.update(..., { code: "SPOOFED" })`)
 *     are caught even when they aren't in the caller's input payload.
 *
 * Violations raised from the `ctx.update` wrapper throw
 * {@link LockViolationError} / {@link LockPreflightError}; the executor's
 * Step 7 catch recognizes them and converts to the same failed-ActionResult
 * shape Step 4b produces.
 */

import type { FieldDefinition, LockCondition } from "../types/entity";

/**
 * Framework-managed system fields that `lockAllWhen` must not auto-cover.
 * Mirrors `SystemFields` in `types/entity.ts`. `_version` in particular is
 * the optimistic-lock token — masking it as `validation.field.locked` would
 * hide real concurrency conflicts the data provider needs to surface.
 *
 * An explicit per-field `lockWhen` declared on a system field still applies
 * (deliberate authorial intent overrides the auto-exemption).
 */
const SYSTEM_FIELD_NAMES = new Set([
  "id",
  "tenant_id",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
  "_version",
  // `deleted_at` is the soft-delete marker. EntityRegistry.resolve() doesn't
  // inject it as a regular field, but generated `restore_*` actions write
  // to it via `ctx.update(..., { deleted_at: null })`. Lock evaluation
  // would otherwise either crash on the missing field map or apply
  // `lockAllWhen` against a non-user field. Treat it as a system field —
  // restore is a framework operation, not a user-driven write that
  // `lockAllWhen` should govern.
  "deleted_at",
  // `status` is the state-machine column. Spec 63 §7.1 says state
  // transitions change the locked field set automatically, so `status`
  // itself MUST be writable while `lockAllWhen` matches — otherwise
  // transitioning out of any locked state is impossible. The declarative
  // path already strips `status` when `stateTransition` is declared; add
  // it here so handler-path writes (`ctx.update(..., { status: "X" })`)
  // get the same treatment. Per-field `lockWhen` declared explicitly on
  // `status` still applies (intentional override).
  "status",
]);

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
 * Attempt to coerce `v` to a millisecond timestamp. Only Dates and strings
 * are eligible: Dates contribute `getTime()`; strings are passed to the
 * `Date` constructor and accepted only when the result is a finite number
 * (so `"banana"` → `NaN` → null, but `"1970-01-01T00:00:00Z"` → 0).
 *
 * Plain numbers are deliberately rejected — a bare `0` shouldn't silently
 * become "epoch" when compared against a Date; such coercion would hide
 * real mismatches.
 */
function toTimestamp(v: unknown): number | null {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "string") {
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/**
 * Structural equality for JSON-serializable values. Unlike a JSON.stringify
 * round-trip, ignores object key order so `{a:1,b:2}` === `{b:2,a:1}`
 * reorderings don't raise false "value changed" violations.
 *
 * Handles primitives, arrays, plain objects, and Date instances. Also
 * applies cross-type Date/ISO-string coercion: a stored Date and an
 * incoming ISO-like string are compared by timestamp so a re-submitted
 * datetime value doesn't trip immutable enforcement just because the
 * transport serialized it to a string.
 *
 * Field constraints do not allow Maps, class instances, or cyclic
 * structures (see FieldDefinition types), so those cases need not be
 * considered.
 */
function structuralEqual(a: unknown, b: unknown, seen?: WeakSet<object>): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;

  // Cross-type Date/string coercion. Only triggers when at least one side
  // is a Date — pure string-vs-string comparisons remain strict-eq (already
  // handled above via `a === b`). The guard prevents `"2024"` from being
  // silently equated to `"2024-01-01"` just because both parse to the same
  // millisecond on a generous `Date` parser.
  if (a instanceof Date || b instanceof Date) {
    const at = toTimestamp(a);
    const bt = toTimestamp(b);
    // If either side fails to coerce (e.g., Date vs "banana" or
    // Date vs { foo: 1 }), treat them as not-equal. We don't fall through
    // to the later typeof branches — one side is definitively a Date, and
    // arbitrary objects vs Dates are never structurally equal.
    if (at === null || bt === null) return false;
    return at === bt;
  }

  const ta = typeof a;
  const tb = typeof b;
  if (ta !== tb) return false;
  if (ta !== "object") return false;

  // Cycle protection (Gemini PR #203 review). FieldDefinition types reject
  // cyclic structures at construction, but values arrive here from runtime
  // sources (handlers, external APIs, untyped DB rows) where a cycle could
  // slip through and turn the recursive walk into a stack overflow. Track
  // the *current recursion path* via WeakSet — add on descent, remove on
  // ascent — so legitimate shared references like `{ x: shared, y: shared }`
  // still compare correctly while true cycles bail out as not-equal.
  const path = seen ?? new WeakSet<object>();
  if (path.has(a as object) || path.has(b as object)) return false;

  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr && bArr) {
    if (a.length !== b.length) return false;
    path.add(a as object);
    path.add(b as object);
    try {
      for (let i = 0; i < a.length; i++) {
        if (!structuralEqual(a[i], b[i], path)) return false;
      }
    } finally {
      path.delete(a as object);
      path.delete(b as object);
    }
    return true;
  }

  // Guard against other non-plain objects (Map, Set, class instances).
  // Two different instances of a class with no enumerable own keys would
  // otherwise compare as equal. For these, require reference identity
  // (already checked at the top — so falling here means they're different).
  const aProto = Object.getPrototypeOf(a);
  const bProto = Object.getPrototypeOf(b);
  const plainA = aProto === Object.prototype || aProto === null;
  const plainB = bProto === Object.prototype || bProto === null;
  if (!plainA || !plainB) return false;

  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao);
  const bKeys = Object.keys(bo);
  if (aKeys.length !== bKeys.length) return false;
  path.add(a as object);
  path.add(b as object);
  try {
    for (const k of aKeys) {
      if (!Object.hasOwn(bo, k)) return false;
      if (!structuralEqual(ao[k], bo[k], path)) return false;
    }
  } finally {
    path.delete(a as object);
    path.delete(b as object);
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
    //
    // TODO(spec-63 Phase 2): translatable fields stored as locale maps need
    // locale-aware normalization. The earlier "any locale value matches"
    // shortcut was over-permissive — a caller could change an immutable
    // translatable field by submitting another locale's existing value
    // (which then silently overwrites the active locale). Proper handling
    // requires the active write locale, which Phase 1 doesn't propagate
    // into the checker. Until then, plain-string vs locale-map mismatches
    // fall through to structuralEqual (always different), so common UI
    // round-trips on immutable translatable fields surface as violations.
    // Document this as a known Phase 1 limitation; UI/clients should send
    // the full locale map for translatable updates.
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
    //
    //    System fields (id, tenant_id, created_at, updated_at, created_by,
    //    updated_by, _version) are framework-managed and exempt from
    //    `lockAllWhen` — `_version` in particular is the optimistic-lock
    //    token and must reach the data provider's conflict check, not get
    //    masked here. Per-field `lockWhen` declared explicitly on a system
    //    field still wins (an explicit declaration is intentional).
    const isSystemField = SYSTEM_FIELD_NAMES.has(fieldName);
    const lockCondition: LockCondition | undefined =
      field.lockWhen ??
      (lockAllowFields?.includes(fieldName) || isSystemField ? undefined : lockAllWhen);

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

/**
 * Thrown from the `ctx.update()` wrapper when the executor detects a
 * field-lock violation on a handler-initiated write. The executor's Step 7
 * catch recognizes this class and converts it to a failed `ActionResult`
 * with the same payload shape Step 4b produces for declarative updates.
 *
 * Carries the full violations array so the error result retains per-field
 * detail identical to the declarative path.
 */
export class LockViolationError extends Error {
  readonly violations: readonly FieldLockViolation[];
  readonly entity: string;

  constructor(violations: readonly FieldLockViolation[], entity: string) {
    super("Field lock violation");
    this.name = "LockViolationError";
    this.violations = violations;
    this.entity = entity;
  }
}

/**
 * Thrown from the `ctx.update()` wrapper when the record can't be read
 * prior to applying the lock check. The wrapper fails closed (matching
 * Step 4b's preflight behavior for declarative updates) rather than
 * allowing a write to bypass the check because the existing state is
 * unknown.
 */
export class LockPreflightError extends Error {
  readonly entity: string;
  readonly recordId: string;

  constructor(entity: string, recordId: string) {
    super(
      `Cannot verify field locks: record "${recordId}" in entity "${entity}" could not be read`,
    );
    this.name = "LockPreflightError";
    this.entity = entity;
    this.recordId = recordId;
  }
}
