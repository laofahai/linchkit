/**
 * Capability hub — discovery, dependency, extension resolution (browser-safe).
 */

export type {
  ActionOverrideEntry,
  CapabilityDependency,
  CapabilityManifest,
  CapabilityProvides,
  CapabilityRequires,
  CapabilitySearchOptions,
  CompatibilityIssue,
  EntityExtensionEntry,
  EntityOverrideEntry,
  ExtensionResolver,
  RegistryEntry,
  RegistrySearchOptions,
  ResolutionConflict,
  RuleOverrideEntry,
  TrustLevel,
  ValidationResult,
} from "../../capability";
export {
  buildActionChain,
  CapabilityHub,
  CapabilityHubError,
  checkTrustPermissions,
  createCapabilityHub,
  createExtensionResolver,
  createLocalRegistry,
  filterEntityByCapabilities,
  LocalCapabilityRegistry,
  satisfiesVersionRange,
} from "../../capability";
