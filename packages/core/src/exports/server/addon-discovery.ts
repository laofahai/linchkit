/**
 * Addon discovery (Spec 57) — filesystem scanner + auto-install resolver.
 */

export { scanAddonsPath } from "../../capability/addon-scanner";
export { resolveAutoInstall, resolveDependencies } from "../../capability/auto-install";
export { mergeCapabilityPool, resolveCapabilities } from "../../capability/resolve-capabilities";
