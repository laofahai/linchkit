/**
 * Effective capability trust resolution (Spec 21 / issue #122, PR-2).
 *
 * Trust tiers (`TrustLevel`) gate which `systemPermissions` a capability may
 * hold (enforced by `checkTrustPermissions`). A capability MAY declare its own
 * `trustLevel`, but a declaration can only ever LOWER its standing — never
 * raise it above what the package name justifies. This module is the single
 * source of truth for both the name-based inference (previously duplicated in
 * the CLI's `install`/`publish` commands) and the anti-spoof clamp.
 *
 * Kept separate from `compatibility.ts` (which is about core *versions*) so
 * each module owns one concern.
 */

import { TRUST_LEVEL_ORDER, type TrustLevel } from "../types/trust";

// ── Name-based inference ─────────────────────────────────

/**
 * Infer a trust tier from a package-name convention. This is the only tier a
 * package can *earn automatically*:
 *
 * - `@linchkit/*`     → `official`  (first-party scope).
 * - `linchkit-cap-*`  → `community` (published, automated checks only).
 * - anything else     → `unverified`.
 *
 * NOTE: `verified` is never inferred — it is registry-assigned after review
 * (deferred to #85). So name-based inference caps the ceiling at `official`
 * for first-party and `community` for everyone else.
 */
export function inferTrustLevel(packageName: string): TrustLevel {
  if (packageName.startsWith("@linchkit/")) return "official";
  if (packageName.startsWith("linchkit-cap-")) return "community";
  return "unverified";
}

// ── Anti-spoof clamp ─────────────────────────────────────

/**
 * Clamp a candidate tier so it never exceeds a ceiling. Returns whichever tier
 * has the lower {@link TRUST_LEVEL_ORDER} rank (i.e. the less-trusted one).
 */
export function clampTrust(candidate: TrustLevel, ceiling: TrustLevel): TrustLevel {
  return TRUST_LEVEL_ORDER[candidate] <= TRUST_LEVEL_ORDER[ceiling] ? candidate : ceiling;
}

// ── Effective trust ──────────────────────────────────────

/** Inputs for {@link computeEffectiveTrust}. */
export interface ComputeEffectiveTrustInput {
  /** Package name, used to infer the name-justified ceiling. */
  name: string;
  /**
   * Trust tier the capability declared for itself (e.g. via
   * `capability.json`'s top-level `trustLevel`, or a `CapabilityDefinition`).
   * Optional — when absent the inferred tier is used verbatim.
   */
  declaredTrust?: TrustLevel;
}

/**
 * Compute a capability's EFFECTIVE trust tier.
 *
 *   effective = clamp(declaredTrust ?? inferred, ceiling = inferred)
 *
 * - When nothing is declared, the name-inferred tier is returned unchanged.
 * - A declared tier may only LOWER (or equal) the name-justified tier. A
 *   `community`-named package that declares `official` is clamped back down to
 *   `community` (anti-spoof). A package declaring a *lower* tier than its name
 *   justifies is honored — opting into stricter sandboxing is always allowed.
 */
export function computeEffectiveTrust({
  name,
  declaredTrust,
}: ComputeEffectiveTrustInput): TrustLevel {
  const inferred = inferTrustLevel(name);
  if (declaredTrust === undefined) return inferred;
  return clampTrust(declaredTrust, inferred);
}
