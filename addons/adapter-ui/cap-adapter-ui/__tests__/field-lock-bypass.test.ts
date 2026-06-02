/**
 * Tests for the field-lock bypass UI logic (Spec 63 §5.2).
 *
 * This package's test setup is logic-only (no jsdom / happy-dom — see
 * action-proposal-card.test.ts), so the FieldLockBadge is exercised through its
 * pure `resolveLockTooltip` helper (the reason→text mapping the static, non-
 * bypass path renders), and `fetchCanBypass` (the hook's data layer) through an
 * injected `graphql` stub. Injection keeps the data-layer tests deterministic
 * and independent of any global `fetch` state or batched-runner test ordering
 * (reassigning `globalThis.fetch` proved flaky under the CI runner).
 */

import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import { resolveLockTooltip } from "../src/components/field-lock-badge";
import { fetchCanBypass } from "../src/hooks/use-field-lock-bypass";

// ── resolveLockTooltip (static badge text mapping) ───────────

/**
 * Translation stub that echoes the default value, interpolating {{status}}.
 * Cast to `TFunction` — i18next's `t` is heavily overloaded, and only the
 * `(key, default)` / `(key, { defaultValue, status })` call shapes used by
 * `resolveLockTooltip` are exercised here.
 */
const t = ((key: string, options?: string | Record<string, unknown>): string => {
  if (typeof options === "string") return options;
  if (options && typeof options === "object") {
    const def = typeof options.defaultValue === "string" ? options.defaultValue : key;
    const status = options.status;
    return typeof status === "string" ? def.replace("{{status}}", status) : def;
  }
  return key;
}) as unknown as TFunction;

describe("resolveLockTooltip", () => {
  test("immutable reason → immutable message", () => {
    expect(resolveLockTooltip(t, "immutable")).toBe("This field cannot be changed after creation");
  });

  test("locked reason without status → generic locked message", () => {
    expect(resolveLockTooltip(t, "locked")).toBe("This field is locked in the current state");
  });

  test("locked reason with status → state-specific message", () => {
    expect(resolveLockTooltip(t, "locked", "submitted")).toBe(
      'Locked because the record is in state "submitted"',
    );
  });

  // Spec 63 §4.2 SOFT_LOCK — a soft-locked, not-yet-confirmed field gets the
  // "editing requires confirmation" message regardless of reason/status.
  test("soft lock not yet unlocked → softLocked confirmation prompt", () => {
    expect(resolveLockTooltip(t, "locked", "submitted", { soft: true, unlocked: false })).toBe(
      "Locked — editing requires confirmation. Click to confirm.",
    );
  });

  test("soft lock already unlocked → falls through to the normal reason message", () => {
    // Once unlocked, the soft prompt no longer applies; the standard mapping wins.
    expect(resolveLockTooltip(t, "locked", "submitted", { soft: true, unlocked: true })).toBe(
      'Locked because the record is in state "submitted"',
    );
  });
});

// ── fetchCanBypass (hook data layer) ─────────────────────────

/** Deterministic `graphql` stub that resolves to `body` — no real network/fetch. */
function stubGraphql(body: unknown): Parameters<typeof fetchCanBypass>[0] {
  return (async () => body) as unknown as Parameters<typeof fetchCanBypass>[0];
}

describe("fetchCanBypass", () => {
  test("returns true when fieldLockBypass.canBypass is true", async () => {
    expect(
      await fetchCanBypass(
        stubGraphql({ data: { fieldLockBypass: { canBypass: true, reason: "bypass" } } }),
      ),
    ).toBe(true);
  });

  test("returns false when fieldLockBypass.canBypass is false", async () => {
    expect(
      await fetchCanBypass(
        stubGraphql({ data: { fieldLockBypass: { canBypass: false, reason: null } } }),
      ),
    ).toBe(false);
  });

  test("returns false (swallows error) when the field is missing (cap-lock not installed)", async () => {
    // GraphQL validation error shape returned when `fieldLockBypass` is unknown.
    expect(
      await fetchCanBypass(
        stubGraphql({
          errors: [{ message: 'Cannot query field "fieldLockBypass" on type "Query".' }],
        }),
      ),
    ).toBe(false);
  });

  test("returns false when data is absent entirely", async () => {
    expect(await fetchCanBypass(stubGraphql({}))).toBe(false);
  });

  test("returns false on a thrown error (no throw escapes)", async () => {
    const throwing = (async () => {
      throw new Error("network down");
    }) as unknown as Parameters<typeof fetchCanBypass>[0];
    expect(await fetchCanBypass(throwing)).toBe(false);
  });
});
