/**
 * Addon discovery (Spec 57) — filesystem scanner + auto-install resolver.
 * Also re-exports the boot-time core ↔ capability version-compatibility check
 * (Spec 21) so the CLI can enforce it on the resolved capability set.
 */

export { scanAddonsPath } from "../../capability/addon-scanner";
export { resolveAutoInstall, resolveDependencies } from "../../capability/auto-install";
export type {
  CompatCapability,
  CompatIssue,
  CoreCompatibilityResult,
  EnforceCoreCompatibilityOptions,
} from "../../capability/compatibility";
export { checkCoreCompatibility, enforceCoreCompatibility } from "../../capability/compatibility";
export { mergeCapabilityPool, resolveCapabilities } from "../../capability/resolve-capabilities";
