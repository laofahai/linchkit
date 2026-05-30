---
"@linchkit/core": minor
"@linchkit/cli": patch
---

feat(spec-21): declarable, anti-spoof-clamped capability trust tiers (#122)

Capabilities may now self-declare a `trustLevel` on their `CapabilityDefinition` and in `capability.json` (top-level `trustLevel`). The declaration is anti-spoof: a new `computeEffectiveTrust` helper resolves the effective tier as `clamp(declared ?? inferred, ceiling = name-inferred)`, so a declaration can only ever LOWER (or equal) the tier the package name justifies — never raise it (a `linchkit-cap-*` package declaring `official` is clamped back to `community`). Opting into a stricter tier than the name justifies is honored. Name-based inference (`@linchkit/*` → `official`, `linchkit-cap-*` → `community`, else `unverified`) plus the clamp now live in `@linchkit/core` as the single source of truth, deduplicating the copies previously embedded in the CLI `install` and `publish` commands. The resolved effective tier continues to gate `systemPermissions` via `checkTrustPermissions`; undeclared capabilities behave exactly as before. The `verified` tier is registry-assigned and remains deferred to #85 (never inferred). Non-breaking — `trustLevel` is optional everywhere.
