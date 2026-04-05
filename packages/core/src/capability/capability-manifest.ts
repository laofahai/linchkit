/**
 * Capability Manifest — metadata format for capability discovery
 *
 * A manifest describes what a capability provides and requires,
 * enabling the Hub to resolve dependencies and validate compatibility.
 */

import type { CapabilityCategory, CapabilityType } from "../types/capability";

// ── Dependency descriptor ────────────────────────────────

export interface CapabilityDependency {
  /** Capability name */
  name: string;
  /** SemVer range (e.g. "^1.0.0", ">=2.0.0"). If omitted, any version accepted. */
  versionRange?: string;
  /** If true, the dependency is optional — Hub won't fail if missing */
  optional?: boolean;
}

// ── Extension descriptor ─────────────────────────────────

/** Declares what a capability provides to the system */
export interface CapabilityProvides {
  /** Schema names this capability registers */
  schemas?: string[];
  /** Action names this capability registers */
  actions?: string[];
  /** Service identifiers (e.g. "auth-provider", "mcp-transport") */
  services?: string[];
  /** Extension point identifiers this capability contributes to */
  extensionPoints?: string[];
}

/** Declares what a capability requires from other capabilities */
export interface CapabilityRequires {
  /** Schema names this capability depends on */
  schemas?: string[];
  /** Action names this capability expects to exist */
  actions?: string[];
  /** Service identifiers this capability consumes */
  services?: string[];
}

// ── Manifest ─────────────────────────────────────────────

export interface CapabilityManifest {
  /** Unique capability name (must match CapabilityDefinition.name) */
  name: string;
  /** SemVer version string */
  version: string;
  /** Capability type */
  type: CapabilityType;
  /** Capability category */
  category: CapabilityCategory;
  /** Human-readable label */
  label?: string;
  /** Description of this capability */
  description?: string;
  /** Capabilities this one depends on */
  dependencies?: CapabilityDependency[];
  /** What this capability provides */
  provides?: CapabilityProvides;
  /** What this capability requires from others */
  requires?: CapabilityRequires;
}
