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
  ExtensionResolver,
  ResolutionConflict,
  RuleOverrideEntry,
  EntityExtensionEntry,
  EntityOverrideEntry,
} from "./extension-resolver";
export {
  buildActionChain,
  createExtensionResolver,
} from "./extension-resolver";
export { filterSchemaByCapabilities } from "./filter-schema";
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
