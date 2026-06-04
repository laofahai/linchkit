/**
 * Tests for cap-lock config defaults / normalization / validation (Spec 63 §4.2).
 */

import { describe, expect, it } from "bun:test";
import { resolveCapLockPolicy } from "../src/config";

describe("resolveCapLockPolicy", () => {
  it("applies safe defaults for an empty config (no-op over core)", () => {
    const policy = resolveCapLockPolicy();
    expect(policy.shadowMode).toBe(false);
    expect(policy.bypassGroups).toEqual([]);
    expect(policy.toleranceMs).toBe(0);
  });

  it("preserves explicitly provided values", () => {
    const policy = resolveCapLockPolicy({
      shadowMode: true,
      bypassGroups: ["admin", "finance_manager"],
      toleranceMs: 60_000,
    });
    expect(policy.shadowMode).toBe(true);
    expect(policy.bypassGroups).toEqual(["admin", "finance_manager"]);
    expect(policy.toleranceMs).toBe(60_000);
  });

  it("rejects a negative toleranceMs", () => {
    expect(() => resolveCapLockPolicy({ toleranceMs: -1 })).toThrow();
  });

  it("rejects a non-integer toleranceMs", () => {
    expect(() => resolveCapLockPolicy({ toleranceMs: 1.5 })).toThrow();
  });

  it("rejects unknown config keys (strict schema)", () => {
    // @ts-expect-error — unknown key is rejected at runtime by .strict().
    expect(() => resolveCapLockPolicy({ bogus: true })).toThrow();
  });
});
