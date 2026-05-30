/**
 * Capability trust tiers (Spec 21 / issue #122).
 *
 * A capability's trust level governs how much the runtime is willing to grant
 * it — most concretely, which `systemPermissions` it may hold (see
 * `checkTrustPermissions` in `capability/local-registry.ts`).
 *
 * This type lives in `types/` rather than alongside `checkTrustPermissions`
 * so that `types/capability.ts` can reference it WITHOUT importing from
 * `capability/local-registry.ts` — that would create a
 * `types → capability → types` import cycle (capability/local-registry.ts
 * already imports `CapabilityType` from `types/capability.ts`). The runtime
 * permission helper re-exports `TrustLevel` from here so existing importers of
 * `@linchkit/core` are unaffected.
 */

import { z } from "zod";

// ── Trust levels ────────────────────────────────────────

/**
 * Capability trust tiers, ordered from least to most trusted by
 * {@link TRUST_LEVEL_ORDER}.
 *
 * - `official`   — first-party `@linchkit/*` packages.
 * - `verified`   — registry-reviewed third-party (assigned, never inferred;
 *                  deferred to #85 — name-based inference can only ever reach
 *                  `community`).
 * - `community`  — published `linchkit-cap-*` packages (automated checks only).
 * - `unverified` — anything else (e.g. local paths, unknown registries).
 */
export type TrustLevel = "official" | "verified" | "community" | "unverified";

/** Zod enum mirror of {@link TrustLevel} for `capability.json` validation. */
export const trustLevelEnum = z.enum(["official", "verified", "community", "unverified"]);

// ── Ordering ─────────────────────────────────────────────

/**
 * Numeric rank per tier (higher = more trusted). Used by the anti-spoof clamp:
 * a declared trust may only LOWER (or equal) the name-justified tier, never
 * raise it.
 */
export const TRUST_LEVEL_ORDER: Record<TrustLevel, number> = {
  unverified: 0,
  community: 1,
  verified: 2,
  official: 3,
};
