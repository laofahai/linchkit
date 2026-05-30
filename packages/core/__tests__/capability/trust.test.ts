import { describe, expect, it } from "bun:test";
import { checkTrustPermissions } from "../../src/capability/local-registry";
import { clampTrust, computeEffectiveTrust, inferTrustLevel } from "../../src/capability/trust";
import { TRUST_LEVEL_ORDER, type TrustLevel } from "../../src/types/trust";

// ── Name-based inference ─────────────────────────────────

describe("inferTrustLevel", () => {
  it("infers `official` for first-party @linchkit/* scope", () => {
    expect(inferTrustLevel("@linchkit/cap-auth")).toBe("official");
    expect(inferTrustLevel("@linchkit/core")).toBe("official");
  });

  it("infers `community` for published linchkit-cap-* packages", () => {
    expect(inferTrustLevel("linchkit-cap-crm")).toBe("community");
    expect(inferTrustLevel("linchkit-cap-inventory")).toBe("community");
  });

  it("infers `unverified` for everything else", () => {
    expect(inferTrustLevel("some-random-package")).toBe("unverified");
    expect(inferTrustLevel("@other/cap-something")).toBe("unverified");
    expect(inferTrustLevel("./local-path")).toBe("unverified");
  });

  it("never infers `verified` (registry-assigned, deferred to #85)", () => {
    const names = ["@linchkit/cap-auth", "linchkit-cap-crm", "some-random-package"];
    for (const name of names) {
      expect(inferTrustLevel(name)).not.toBe("verified");
    }
  });
});

// ── Clamp primitive ──────────────────────────────────────

describe("clampTrust", () => {
  const ALL_TIERS: TrustLevel[] = ["unverified", "community", "verified", "official"];

  it("returns the lower-ranked tier for every (candidate, ceiling) pair", () => {
    for (const candidate of ALL_TIERS) {
      for (const ceiling of ALL_TIERS) {
        const expected =
          TRUST_LEVEL_ORDER[candidate] <= TRUST_LEVEL_ORDER[ceiling] ? candidate : ceiling;
        expect(clampTrust(candidate, ceiling)).toBe(expected);
      }
    }
  });

  it("is identity when candidate equals ceiling", () => {
    for (const tier of ALL_TIERS) {
      expect(clampTrust(tier, tier)).toBe(tier);
    }
  });
});

// ── Effective trust: full clamp matrix ───────────────────

describe("computeEffectiveTrust", () => {
  // Representative package names for each name-inferred ceiling. `verified`
  // cannot be inferred from a name, so it has no name fixture — it only ever
  // appears as a (clamped-down) declared tier.
  const NAME_BY_CEILING: Record<"official" | "community" | "unverified", string> = {
    official: "@linchkit/cap-auth",
    community: "linchkit-cap-crm",
    unverified: "some-random-package",
  };

  const ALL_DECLARED: TrustLevel[] = ["official", "verified", "community", "unverified"];

  /**
   * Full matrix: every declared tier crossed with every name-inferred ceiling.
   * The effective tier is always clamp(declared, ceiling) — i.e. the
   * lower-ranked of the two. This proves a declaration can only ever LOWER or
   * equal the name-justified standing, never raise it.
   */
  it("clamps every (declaredTrust × inferred-from-name) combination", () => {
    for (const [ceiling, name] of Object.entries(NAME_BY_CEILING)) {
      for (const declaredTrust of ALL_DECLARED) {
        const expected = clampTrust(declaredTrust, ceiling as TrustLevel);
        expect(computeEffectiveTrust({ name, declaredTrust })).toBe(expected);
      }
    }
  });

  it("anti-spoof: community-named package declaring `official` is clamped to community", () => {
    expect(computeEffectiveTrust({ name: "linchkit-cap-crm", declaredTrust: "official" })).toBe(
      "community",
    );
  });

  it("anti-spoof: unverified-named package declaring `verified` is clamped to unverified", () => {
    expect(computeEffectiveTrust({ name: "evil-cap", declaredTrust: "verified" })).toBe(
      "unverified",
    );
  });

  it("anti-spoof: unverified-named package declaring `official` is clamped to unverified", () => {
    expect(computeEffectiveTrust({ name: "evil-cap", declaredTrust: "official" })).toBe(
      "unverified",
    );
  });

  it("honors a LOWER declaration than the name justifies (opt-in to stricter sandbox)", () => {
    // Official-named package voluntarily declaring `community` is honored.
    expect(computeEffectiveTrust({ name: "@linchkit/cap-auth", declaredTrust: "community" })).toBe(
      "community",
    );
    // Official-named package declaring `unverified` is honored.
    expect(computeEffectiveTrust({ name: "@linchkit/cap-auth", declaredTrust: "unverified" })).toBe(
      "unverified",
    );
    // Community-named package declaring `unverified` is honored.
    expect(computeEffectiveTrust({ name: "linchkit-cap-crm", declaredTrust: "unverified" })).toBe(
      "unverified",
    );
  });

  it("honors an equal declaration verbatim", () => {
    expect(computeEffectiveTrust({ name: "@linchkit/cap-auth", declaredTrust: "official" })).toBe(
      "official",
    );
    expect(computeEffectiveTrust({ name: "linchkit-cap-crm", declaredTrust: "community" })).toBe(
      "community",
    );
  });

  it("returns the inferred tier verbatim when declaredTrust is undefined", () => {
    expect(computeEffectiveTrust({ name: "@linchkit/cap-auth" })).toBe("official");
    expect(computeEffectiveTrust({ name: "@linchkit/cap-auth", declaredTrust: undefined })).toBe(
      "official",
    );
    expect(computeEffectiveTrust({ name: "linchkit-cap-crm" })).toBe("community");
    expect(computeEffectiveTrust({ name: "some-random-package" })).toBe("unverified");
  });
});

// ── Trust → system permission gating ─────────────────────

describe("effective trust gates system permissions", () => {
  const PRIVILEGED_PERM = "database.drop_table";

  it("denies a privileged permission once a declaration clamps the tier down", () => {
    // An official-named package would normally be allowed everything ("all"),
    // but voluntarily declaring `community` clamps it — and `community` only
    // permits a fixed allowlist, so the privileged perm is denied.
    const effective = computeEffectiveTrust({
      name: "@linchkit/cap-auth",
      declaredTrust: "community",
    });
    expect(effective).toBe("community");

    const check = checkTrustPermissions(effective, [PRIVILEGED_PERM]);
    expect(check.allowed).toBe(false);
    expect(check.denied).toEqual([PRIVILEGED_PERM]);
  });

  it("anti-spoof: a community-named cap claiming `official` is still denied privileged perms", () => {
    const effective = computeEffectiveTrust({
      name: "linchkit-cap-crm",
      declaredTrust: "official",
    });
    expect(effective).toBe("community");
    expect(checkTrustPermissions(effective, [PRIVILEGED_PERM]).allowed).toBe(false);
  });

  it("regression guard: an UNDECLARED capability behaves exactly as before (no-op)", () => {
    // No declaration → effective tier is the name-inferred tier verbatim, so
    // the permission decision is identical to feeding the inferred tier
    // straight into checkTrustPermissions (the pre-trust-tiers behavior).
    const cases: Array<{ name: string; perms: string[] }> = [
      { name: "@linchkit/cap-auth", perms: [PRIVILEGED_PERM, "database.create_table"] },
      { name: "linchkit-cap-crm", perms: ["database.create_table", "database.create_index"] },
      { name: "linchkit-cap-crm", perms: [PRIVILEGED_PERM] },
      { name: "some-random-package", perms: ["database.create_table"] },
    ];
    for (const { name, perms } of cases) {
      const inferred = inferTrustLevel(name);
      const effective = computeEffectiveTrust({ name });
      // Effective with no declaration === inferred.
      expect(effective).toBe(inferred);
      // And the permission verdict is byte-for-byte the legacy verdict.
      expect(checkTrustPermissions(effective, perms)).toEqual(
        checkTrustPermissions(inferred, perms),
      );
    }
  });

  it("official (undeclared) still allows everything", () => {
    const effective = computeEffectiveTrust({ name: "@linchkit/cap-auth" });
    expect(checkTrustPermissions(effective, [PRIVILEGED_PERM]).allowed).toBe(true);
  });

  it("community (undeclared) permits its allowlist but denies privileged perms", () => {
    const effective = computeEffectiveTrust({ name: "linchkit-cap-crm" });
    expect(
      checkTrustPermissions(effective, ["database.create_table", "database.create_index"]).allowed,
    ).toBe(true);
    expect(checkTrustPermissions(effective, [PRIVILEGED_PERM]).allowed).toBe(false);
  });
});
