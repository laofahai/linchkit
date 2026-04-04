/**
 * Link type definitions
 *
 * Links define relationships between Schemas as first-class citizens.
 * Supports bidirectional navigation, cardinality declarations, and M:N junction table properties.
 */

import type { FieldDefinition } from "./entity";

// ── Cardinality ──────────────────────────────────────────

export type RelationCardinality = "one_to_one" | "one_to_many" | "many_to_one" | "many_to_many";

// ── Cascade behavior ──────────────────────────────────────────

export type RelationCascade = "none" | "delete" | "nullify";

// ── Link definition ──────────────────────────────────────────

export interface RelationDefinition {
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
  cardinality: RelationCardinality;

  /** Extra properties on the M:N junction table (only for many_to_many) */
  properties?: Record<string, FieldDefinition>;

  /** Cascade behavior when parent is deleted. Default: 'none' */
  cascade?: RelationCascade;

  /** Whether the relationship is required. Default: false */
  required?: boolean;
}

// ── Link info (directional view) ──────────────────────────────────────────

export interface RelationInfo {
  /** The underlying link definition */
  relation: RelationDefinition;

  /** Direction relative to the querying schema */
  direction: "outgoing" | "incoming";

  /** The schema on the other end */
  relatedEntity: string;

  /** Label for this direction */
  label: string;
}

// ── Link registry interface ──────────────────────────────────────────

export interface RelationRegistryInterface {
  /** Register a link definition */
  register(link: RelationDefinition): void;

  /** Get all links for an entity (both outgoing and incoming) */
  relationsFor(entityName: string): RelationInfo[];

  /** Get the link between two entities (if any) */
  relationBetween(from: string, to: string): RelationDefinition | null;

  /** Get all outgoing links from an entity */
  outgoingRelations(entityName: string): RelationDefinition[];

  /** Get all incoming links to an entity */
  incomingRelations(entityName: string): RelationDefinition[];

  /** List all registered links */
  list(): RelationDefinition[];
}
