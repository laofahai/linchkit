---
"@linchkit/core": minor
"@linchkit/cli": patch
---

feat(spec-21): capability ↔ core version-compatibility check (#122)

Adds a boot-time compatibility check between capabilities and the running `@linchkit/core` version. Capabilities may declare a `coreVersion` semver RANGE (e.g. `^0.2.0`, `>=0.2.0 <0.4.0`) on their `CapabilityDefinition` and in `capability.json` (`linchkit.coreVersion`); when present it supersedes the now-deprecated `linchkit.minVersion`, which keeps working as a fallback. New `checkCoreCompatibility` / `enforceCoreCompatibility` helpers evaluate the resolved capability set against the core `VERSION`. `satisfiesVersionRange` now also parses whitespace-joined compound (AND) ranges. The CLI `dev` boot wires `enforceCoreCompatibility` after capability resolution in WARN-only mode (strict-refuse stays gated off until core `VERSION` is reconciled with addon declarations) so dev boot is never broken. `linch install` prefers `coreVersion ?? minVersion`. Non-breaking — both fields are optional.
