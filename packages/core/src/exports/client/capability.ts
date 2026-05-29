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
  MetadataCompatibility,
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
  coreVersionRangeOf,
  createCapabilityHub,
  createExtensionResolver,
  createLocalRegistry,
  enforceCoreCompatibility,
  filterEntityByCapabilities,
  LocalCapabilityRegistry,
  normalizeMinVersion,
  satisfiesVersionRange,
} from "../../capability";
