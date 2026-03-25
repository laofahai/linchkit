/**
 * Capability Hub module — public exports
 *
 * Capability discovery, dependency resolution, and manifest management.
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
