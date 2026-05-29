---
"@linchkit/core": minor
"@linchkit/cli": patch
---

fix(spec-21): make the core ↔ capability compatibility check fire for shipped addons (#122)

The Spec 21 / #122 compatibility check was inert for every real addon: shipped
`package.json` files declare `linchkit.minCoreVersion`, a third key the metadata
schema did not recognize (so it was silently stripped), and the runtime
`CapabilityDefinition.coreVersion` was never populated from disk metadata — so the
boot-time `enforceCoreCompatibility` always saw `undefined` and checked nothing.

- **Schema reconciliation**: `capabilityMetadataSchema.linchkit` now recognizes the
  deprecated `minCoreVersion` alias alongside `coreVersion` and `minVersion`.
  `coreVersionRangeOf` resolves the effective range with precedence
  `coreVersion ?? minVersion ?? minCoreVersion`; `minVersion` and `minCoreVersion`
  are normalized to a `>=` range (a value that is already a range is kept verbatim).
- **Runtime population**: `scanAddonsPath` now populates `CapabilityDefinition.coreVersion`
  from the scanned addon's `package.json` `linchkit` block via `coreVersionRangeOf`, so
  the boot check has a real range to evaluate. An explicit range on the definition still wins.

Strict enforcement remains hard-gated off (`STRICT_COMPAT_READY=false` in `dev.ts`):
with core `VERSION` `0.0.1` vs addon ranges like `^0.2.0`, this surfaces WARN lines,
never a throw. Non-breaking — all three `linchkit` version keys are optional.
