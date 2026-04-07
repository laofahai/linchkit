/**
 * Capability registry types
 *
 * Defines the shape of aggregated capability metadata used by
 * `linch install`, bootstrap skills, and AI agents.
 */

export interface CapabilityRegistryEntry {
  /** npm package name (e.g. @linchkit/cap-chatter) */
  name: string;
  /** Package version */
  version: string;
  /** Package description */
  description: string;
  /** Capability type */
  type: "standard" | "adapter" | "bridge";
  /** Capability category (e.g. system, transport, collaboration) */
  category: string;
  /** semver range for @linchkit/core compatibility */
  compatibility: string;
  /** Other @linchkit/cap-* packages this capability depends on */
  dependencies: string[];
  /** Whether this is an official LinchKit capability */
  official: boolean;
}

export interface CapabilityRegistry {
  /** Registry format version */
  version: string;
  /** ISO timestamp of generation */
  generated: string;
  /** All discovered capabilities */
  capabilities: CapabilityRegistryEntry[];
}
