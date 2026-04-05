/**
 * Capability Hub module — public exports
 *
 * Capability discovery, dependency resolution, manifest management,
 * and local registry for file-based capability tracking.
 */

export type {
  CapabilitySearchOptions,
  CompatibilityIssue,
  ValidationResult,
} from "./capability-hub";
export {
  CapabilityHub,
  CapabilityHubError,
  createCapabilityHub,
  satisfiesVersionRange,
} from "./capability-hub";
export type {
  CapabilityDependency,
  CapabilityManifest,
  CapabilityProvides,
  CapabilityRequires,
} from "./capability-manifest";
export type {
  ActionOverrideEntry,
  EntityExtensionEntry,
  EntityOverrideEntry,
  ExtensionResolver,
  ResolutionConflict,
  RuleOverrideEntry,
} from "./extension-resolver";
export {
  buildActionChain,
  createExtensionResolver,
} from "./extension-resolver";
export { filterEntityByCapabilities } from "./filter-entity";
export type {
  RegistryEntry,
  RegistrySearchOptions,
  TrustLevel,
} from "./local-registry";
export {
  checkTrustPermissions,
  createLocalRegistry,
  LocalCapabilityRegistry,
} from "./local-registry";
