/**
 * Link type definitions
 *
 * Links define relationships between Schemas as first-class citizens.
 * Supports bidirectional navigation, cardinality declarations, and M:N junction table properties.
 */

import type { FieldDefinition } from "./schema";

// ── Cardinality ──────────────────────────────────────────

export type LinkCardinality =
  | "one_to_one"
  | "one_to_many"
  | "many_to_one"
  | "many_to_many";

// ── Cascade behavior ──────────────────────────────────────────

export type LinkCascade = "none" | "delete" | "nullify";

// ── Link definition ──────────────────────────────────────────

export interface LinkDefinition {
  /** Unique identifier for this link */
  name: string;

  /** Human-readable labels from each direction */
  label?: {
    /** Label when viewed from the `from` side (e.g. "Department") */
    from?: string;
    /** Label when viewed from the `to` side (e.g. "Purchase Requests") */
    to?: string;
  };

  description?: string;

  /** Source schema name */
  from: string;

  /** Target schema name */
  to: string;

  /** Relationship cardinality */
  cardinality: LinkCardinality;

  /** Extra fields on the M:N junction table (only for many_to_many) */
  properties?: Record<string, FieldDefinition>;

  /** Cascade behavior when parent is deleted. Default: 'none' */
  cascade?: LinkCascade;

  /** Whether the relationship is required. Default: false */
  required?: boolean;
}

// ── Link info (directional view) ──────────────────────────────────────────

export interface LinkInfo {
  /** The underlying link definition */
  link: LinkDefinition;

  /** Direction relative to the querying schema */
  direction: "outgoing" | "incoming";

  /** The schema on the other end */
  relatedSchema: string;

  /** Label for this direction */
  label: string;
}

// ── Link registry interface ──────────────────────────────────────────

export interface LinkRegistryInterface {
  /** Register a link definition */
  register(link: LinkDefinition): void;

  /** Get all links for a schema (both outgoing and incoming) */
  linksFor(schemaName: string): LinkInfo[];

  /** Get the link between two schemas (if any) */
  linkBetween(from: string, to: string): LinkDefinition | null;

  /** Get all outgoing links from a schema */
  outgoingLinks(schemaName: string): LinkDefinition[];

  /** Get all incoming links to a schema */
  incomingLinks(schemaName: string): LinkDefinition[];

  /** List all registered links */
  list(): LinkDefinition[];
}
