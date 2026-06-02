/**
 * Spec 63 §4.2 SOFT_LOCK — `FieldLockViolation.mode` classification.
 *
 * Unit-level coverage of `checkFieldLocks`: every emitted violation carries a
 * `mode` ("hard" | "soft"). `immutable` is always hard; a conditional `locked`
 * violation honors the field's `lockMode` (default hard).
 */

import { describe, expect, it } from "bun:test";
import { checkFieldLocks } from "../src/engine/field-lock-checker";
import type { FieldDefinition } from "../src/types/entity";

describe("Spec 63 §4.2 — FieldLockViolation.mode", () => {
  it("immutable violation is always mode=hard", () => {
    const fields: Record<string, FieldDefinition> = {
      code: { type: "string", immutable: true },
    };
    const violations = checkFieldLocks({
      fields,
      existingRecord: { code: "ORIG" },
      input: { code: "NEW" },
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.type).toBe("immutable");
    expect(violations[0]?.mode).toBe("hard");
  });

  it("conditional lock defaults to mode=hard when lockMode is unset", () => {
    const fields: Record<string, FieldDefinition> = {
      amount: { type: "number", lockWhen: { state: "submitted" } },
    };
    const violations = checkFieldLocks({
      fields,
      existingRecord: { status: "submitted", amount: 100 },
      input: { amount: 200 },
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.type).toBe("locked");
    expect(violations[0]?.mode).toBe("hard");
  });

  it("conditional lock with lockMode=soft yields mode=soft", () => {
    const fields: Record<string, FieldDefinition> = {
      amount: { type: "number", lockWhen: { state: "submitted" }, lockMode: "soft" },
    };
    const violations = checkFieldLocks({
      fields,
      existingRecord: { status: "submitted", amount: 100 },
      input: { amount: 200 },
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.type).toBe("locked");
    expect(violations[0]?.mode).toBe("soft");
  });

  it("lockMode=soft does NOT soften an immutable field (immutable stays hard)", () => {
    const fields: Record<string, FieldDefinition> = {
      // Contradictory authoring: immutable + soft. Immutable always wins hard.
      code: { type: "string", immutable: true, lockMode: "soft" },
    };
    const violations = checkFieldLocks({
      fields,
      existingRecord: { code: "ORIG" },
      input: { code: "NEW" },
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.type).toBe("immutable");
    expect(violations[0]?.mode).toBe("hard");
  });

  it("entity-level lockAllWhen on a soft field still emits mode=soft", () => {
    const fields: Record<string, FieldDefinition> = {
      amount: { type: "number", lockMode: "soft" },
    };
    const violations = checkFieldLocks({
      fields,
      lockAllWhen: { state: "submitted" },
      existingRecord: { status: "submitted", amount: 100 },
      input: { amount: 200 },
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.type).toBe("locked");
    expect(violations[0]?.mode).toBe("soft");
  });
});
