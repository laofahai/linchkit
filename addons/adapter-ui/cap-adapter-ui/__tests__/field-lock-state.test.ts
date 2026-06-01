/**
 * Tests for the auto-form field-lock state logic (Spec 63 §5.1).
 *
 * Exercises the REAL pure helpers backing `useFieldLockState`:
 *   - `matchesLockCondition` — now REUSED from `@linchkit/core` and merely
 *     re-exported by the UI module (no longer a mirror)
 *   - `computeFieldLockState` / `computeEntityLockState`
 *
 * The `matchesLockCondition` section both confirms the UI delegates to core's
 * authoritative predicate (identity check) and documents the lock-state
 * semantics the form relies on. The previous "parity vs the mirror" tests are
 * obsolete now that there is a single source of truth in core.
 */

import { describe, expect, test } from "bun:test";
import { matchesLockCondition as coreMatchesLockCondition } from "@linchkit/core";
import type { EntityDefinition, FieldDefinition, LockCondition } from "@linchkit/core/types";
import {
  computeEntityLockState,
  computeFieldLockState,
  matchesLockCondition,
} from "../src/lib/field-lock-state";

// ── matchesLockCondition (delegates to core/engine/field-lock-checker.ts) ──

describe("matchesLockCondition", () => {
  test("UI module re-exports core's authoritative matcher (no local copy)", () => {
    expect(matchesLockCondition).toBe(coreMatchesLockCondition);
  });

  test("string state: matches when status equals", () => {
    expect(matchesLockCondition({ status: "submitted" }, { state: "submitted" })).toBe(true);
    expect(matchesLockCondition({ status: "draft" }, { state: "submitted" })).toBe(false);
  });

  test("string state: no status set → no match", () => {
    expect(matchesLockCondition({}, { state: "submitted" })).toBe(false);
  });

  test("array state: matches any listed status", () => {
    const cond: LockCondition = { state: ["submitted", "approved"] };
    expect(matchesLockCondition({ status: "submitted" }, cond)).toBe(true);
    expect(matchesLockCondition({ status: "approved" }, cond)).toBe(true);
    expect(matchesLockCondition({ status: "draft" }, cond)).toBe(false);
  });

  test("array state: unset status never matches", () => {
    expect(matchesLockCondition({}, { state: ["submitted"] })).toBe(false);
  });

  test("not (string): locks when status is anything except the excluded value", () => {
    const cond: LockCondition = { state: { not: "draft" } };
    expect(matchesLockCondition({ status: "submitted" }, cond)).toBe(true);
    expect(matchesLockCondition({ status: "draft" }, cond)).toBe(false);
  });

  test("not (string): unset status does NOT match a not-clause", () => {
    // Mirrors core: can't exclude what isn't there — avoids false positives on
    // records that don't use a status field at all.
    expect(matchesLockCondition({}, { state: { not: "draft" } })).toBe(false);
  });

  test("not (array): locks when status is none of the excluded values", () => {
    const cond: LockCondition = { state: { not: ["draft", "rejected"] } };
    expect(matchesLockCondition({ status: "approved" }, cond)).toBe(true);
    expect(matchesLockCondition({ status: "draft" }, cond)).toBe(false);
    expect(matchesLockCondition({ status: "rejected" }, cond)).toBe(false);
  });

  test("condition without state clause (domain-only / empty) is a no-op → false", () => {
    expect(matchesLockCondition({ status: "submitted" }, {})).toBe(false);
    expect(matchesLockCondition({ status: "submitted" }, { domain: [["amount", ">", 0]] })).toBe(
      false,
    );
  });
});

// ── computeFieldLockState ──

const stringField: FieldDefinition = { type: "string" };
const immutableField: FieldDefinition = { type: "string", immutable: true };
const readonlyAliasField: FieldDefinition = { type: "string", readonly: true };

describe("computeFieldLockState — immutable", () => {
  test("immutable field is LOCKED on edit", () => {
    const state = computeFieldLockState({
      fieldName: "code",
      fieldDef: immutableField,
      record: { status: "draft" },
      isEditMode: true,
    });
    expect(state).toEqual({ locked: true, reason: "immutable" });
  });

  test("immutable field is NOT locked on create (initial assignment allowed)", () => {
    const state = computeFieldLockState({
      fieldName: "code",
      fieldDef: immutableField,
      record: {},
      isEditMode: false,
    });
    expect(state.locked).toBe(false);
  });

  test("deprecated readonly alias locks on edit too", () => {
    const state = computeFieldLockState({
      fieldName: "code",
      fieldDef: readonlyAliasField,
      record: {},
      isEditMode: true,
    });
    expect(state).toEqual({ locked: true, reason: "immutable" });
  });
});

describe("computeFieldLockState — lockWhen", () => {
  const amountField: FieldDefinition = {
    type: "number",
    lockWhen: { state: ["submitted", "approved"] },
  };

  test("lockWhen true: locked when status matches", () => {
    const state = computeFieldLockState({
      fieldName: "amount",
      fieldDef: amountField,
      record: { status: "submitted" },
      isEditMode: true,
    });
    expect(state.locked).toBe(true);
    expect(state.reason).toBe("locked");
    expect(state.condition).toEqual({ state: ["submitted", "approved"] });
  });

  test("lockWhen false: editable when status does not match", () => {
    const state = computeFieldLockState({
      fieldName: "amount",
      fieldDef: amountField,
      record: { status: "draft" },
      isEditMode: true,
    });
    expect(state.locked).toBe(false);
  });

  test("lockWhen evaluated on create too (state-based, not immutable)", () => {
    // A record that's already in 'submitted' state being edited via create-shaped
    // form data should still honor lockWhen — lockWhen is not immutable.
    const state = computeFieldLockState({
      fieldName: "amount",
      fieldDef: amountField,
      record: { status: "submitted" },
      isEditMode: false,
    });
    expect(state.locked).toBe(true);
  });
});

describe("computeFieldLockState — lockAllWhen + lockAllowFields", () => {
  const lockAllWhen: LockCondition = { state: "posted" };

  test("lockAllWhen locks a plain field when condition matches", () => {
    const state = computeFieldLockState({
      fieldName: "amount",
      fieldDef: stringField,
      record: { status: "posted" },
      isEditMode: true,
      lockAllWhen,
    });
    expect(state.locked).toBe(true);
    expect(state.reason).toBe("locked");
  });

  test("lockAllWhen does NOT lock when condition does not match", () => {
    const state = computeFieldLockState({
      fieldName: "amount",
      fieldDef: stringField,
      record: { status: "draft" },
      isEditMode: true,
      lockAllWhen,
    });
    expect(state.locked).toBe(false);
  });

  test("lockAllowFields exempts a field from lockAllWhen", () => {
    const state = computeFieldLockState({
      fieldName: "notes",
      fieldDef: stringField,
      record: { status: "posted" },
      isEditMode: true,
      lockAllWhen,
      lockAllowFields: ["notes", "tags"],
    });
    expect(state.locked).toBe(false);
  });

  test("system fields are exempt from lockAllWhen", () => {
    const state = computeFieldLockState({
      fieldName: "_version",
      fieldDef: stringField,
      record: { status: "posted" },
      isEditMode: true,
      lockAllWhen,
    });
    expect(state.locked).toBe(false);
  });

  test("status is exempt from lockAllWhen (must stay writable to transition)", () => {
    const state = computeFieldLockState({
      fieldName: "status",
      fieldDef: { type: "state" },
      record: { status: "posted" },
      isEditMode: true,
      lockAllWhen,
    });
    expect(state.locked).toBe(false);
  });

  test("per-field lockWhen beats lockAllowFields exemption", () => {
    // An explicit lockWhen on an allow-listed field still applies — the
    // allowlist only exempts from lockAllWhen, not from explicit per-field locks.
    const state = computeFieldLockState({
      fieldName: "notes",
      fieldDef: { type: "string", lockWhen: { state: "posted" } },
      record: { status: "posted" },
      isEditMode: true,
      lockAllWhen,
      lockAllowFields: ["notes"],
    });
    expect(state.locked).toBe(true);
    expect(state.reason).toBe("locked");
  });
});

describe("computeFieldLockState — precedence", () => {
  test("immutable takes precedence over a matching lockWhen", () => {
    const state = computeFieldLockState({
      fieldName: "code",
      fieldDef: { type: "string", immutable: true, lockWhen: { state: "submitted" } },
      record: { status: "submitted" },
      isEditMode: true,
    });
    expect(state.reason).toBe("immutable");
  });
});

// ── computeEntityLockState ──

describe("computeEntityLockState", () => {
  const entity = {
    name: "invoice",
    fields: {
      code: { type: "string", immutable: true },
      amount: { type: "number", lockWhen: { state: ["submitted", "approved"] } },
      title: { type: "string" },
      notes: { type: "string" },
    },
    lockAllWhen: { state: "posted" },
    lockAllowFields: ["notes"],
  } as unknown as EntityDefinition;

  test("edit mode in 'submitted': immutable + lockWhen locked, others editable", () => {
    const map = computeEntityLockState({
      entity,
      fieldNames: ["code", "amount", "title", "notes"],
      record: { status: "submitted" },
      isEditMode: true,
    });
    expect(map.code?.locked).toBe(true);
    expect(map.code?.reason).toBe("immutable");
    expect(map.amount?.locked).toBe(true);
    expect(map.amount?.reason).toBe("locked");
    expect(map.title?.locked).toBe(false);
    expect(map.notes?.locked).toBe(false);
  });

  test("create mode: immutable NOT locked, lockWhen still honored by state", () => {
    const map = computeEntityLockState({
      entity,
      fieldNames: ["code", "amount", "title"],
      record: { status: "draft" },
      isEditMode: false,
    });
    expect(map.code?.locked).toBe(false);
    expect(map.amount?.locked).toBe(false);
    expect(map.title?.locked).toBe(false);
  });

  test("posted state: lockAllWhen locks everything except allow-listed notes", () => {
    const map = computeEntityLockState({
      entity,
      fieldNames: ["code", "amount", "title", "notes"],
      record: { status: "posted" },
      isEditMode: true,
    });
    expect(map.code?.locked).toBe(true); // immutable
    // A per-field lockWhen WINS over lockAllWhen (core uses `field.lockWhen ??
    // lockAllWhen`). amount.lockWhen does not match 'posted', so amount stays
    // editable even though lockAllWhen matches — lockAllWhen never applies once
    // an explicit per-field lockWhen is declared.
    expect(map.amount?.locked).toBe(false);
    expect(map.title?.locked).toBe(true); // lockAllWhen (no per-field lockWhen)
    expect(map.notes?.locked).toBe(false); // allow-listed
  });

  test("unknown fields (overlay/relation synthetic) are skipped", () => {
    const map = computeEntityLockState({
      entity,
      fieldNames: ["code", "_ovl_custom", "department"],
      record: { status: "submitted" },
      isEditMode: true,
    });
    expect(map.code).toBeDefined();
    expect(map._ovl_custom).toBeUndefined();
    expect(map.department).toBeUndefined();
  });
});
