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
  RegistryEntry,
  RegistrySearchOptions,
  TrustLevel,
} from "./local-registry";
export {
  LocalCapabilityRegistry,
  checkTrustPermissions,
  createLocalRegistry,
} from "./local-registry";
