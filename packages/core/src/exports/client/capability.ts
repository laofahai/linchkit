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
  CompatCapability,
  CompatIssue,
  CompatibilityIssue,
  CoreCompatibilityResult,
  EnforceCoreCompatibilityOptions,
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
  checkCoreCompatibility,
  checkTrustPermissions,
  createCapabilityHub,
  createExtensionResolver,
  createLocalRegistry,
  enforceCoreCompatibility,
  filterEntityByCapabilities,
  LocalCapabilityRegistry,
  satisfiesVersionRange,
} from "../../capability";
