/**
 * Tests for the field-lock bypass UI logic (Spec 63 §5.2).
 *
 * This package's test setup is logic-only (no jsdom / happy-dom — see
 * action-proposal-card.test.ts), so the FieldLockBadge is exercised through its
 * pure `resolveLockTooltip` helper (the reason→text mapping the static, non-
 * bypass path renders), and the `useFieldLockBypass` hook through its exported
 * `fetchCanBypass` helper with fetch mocks (the data extraction + error-swallow
 * behavior the hook depends on).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// Minimal localStorage shim — api.ts reads `linchkit:token` for auth headers.
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

import type { TFunction } from "i18next";
import { resolveLockTooltip } from "../src/components/field-lock-badge";
import { fetchCanBypass, resetFieldLockBypassCache } from "../src/hooks/use-field-lock-bypass";

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
});

// ── fetchCanBypass (hook data layer) ─────────────────────────

let originalFetch: typeof fetch;

function installFetch(body: unknown) {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
}

beforeEach(() => {
  resetFieldLockBypassCache();
});

afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
});

describe("fetchCanBypass", () => {
  test("returns true when fieldLockBypass.canBypass is true", async () => {
    installFetch({ data: { fieldLockBypass: { canBypass: true, reason: "bypass" } } });
    expect(await fetchCanBypass()).toBe(true);
  });

  test("returns false when fieldLockBypass.canBypass is false", async () => {
    installFetch({ data: { fieldLockBypass: { canBypass: false, reason: null } } });
    expect(await fetchCanBypass()).toBe(false);
  });

  test("returns false (swallows error) when the field is missing (cap-lock not installed)", async () => {
    // GraphQL validation error shape returned when `fieldLockBypass` is unknown.
    installFetch({
      errors: [{ message: 'Cannot query field "fieldLockBypass" on type "Query".' }],
    });
    expect(await fetchCanBypass()).toBe(false);
  });

  test("returns false when data is absent entirely", async () => {
    installFetch({});
    expect(await fetchCanBypass()).toBe(false);
  });

  test("returns false on a network/transport failure (no throw)", async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    expect(await fetchCanBypass()).toBe(false);
  });

  test("caches the result — a second call does not refetch", async () => {
    let calls = 0;
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ data: { fieldLockBypass: { canBypass: true } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    expect(await fetchCanBypass()).toBe(true);
    expect(await fetchCanBypass()).toBe(true);
    expect(calls).toBe(1);
  });
});
