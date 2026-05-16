/**
 * Relation type definitions — Spec 61: Semantic Relation Unification
 *
 * Relations define semantic, bidirectional relationships between Entities
 * as first-class citizens. Each relation has semantic navigation names
 * (fromName/toName) used for GraphQL fields, AI queries, and code navigation.
 *
 * All entity relationships are declared via defineRelation() — entity fields
 * no longer contain ref/has_many/many_to_many types.
 */

import type { FieldDefinition } from "./entity";
import type { RelationSemantics } from "./meta-semantics";

// ── Cardinality ──────────────────────────────────────────

export type RelationCardinality = "one_to_one" | "one_to_many" | "many_to_one" | "many_to_many";

// ── Cascade behavior ──────────────────────────────────────────

export type RelationCascade = "none" | "delete" | "nullify";

// ── Relation definition ──────────────────────────────────────────

export interface RelationDefinition {
  /** Unique identifier (e.g. "request_department", "person_authored_doc") */
  name: string;

  /** Source entity name */
  from: string;

  /** Target entity name */
  to: string;

  /** Structural cardinality */
  cardinality: RelationCardinality;

  /**
   * Semantic navigation name from the `from` side.
   * Used as GraphQL field name, code navigation, AI query identifier.
   * Convention: snake_case, English.
   * Example: "department", "authored_documents", "reviewed_documents"
   */
  fromName: string;

  /**
   * Semantic navigation name from the `to` side.
   * Used as reverse GraphQL field name, code navigation, AI query identifier.
   * Example: "purchase_requests", "authors", "reviewers"
   */
  toName: string;

  /**
   * Display labels for UI. Optional. Supports i18n "t:" prefix.
   * Falls back to fromName/toName if not provided.
   */
  label?: {
    /** Label when viewed from the `from` side (e.g. "t:relation.department") */
    from?: string;
    /** Label when viewed from the `to` side (e.g. "t:relation.purchase_requests") */
    to?: string;
  };

  description?: string;

  /** Extra properties on the M:N junction table (only for many_to_many) */
  properties?: Record<string, FieldDefinition>;

  /** Cascade behavior when parent is deleted. Default: 'none' */
  cascade?: RelationCascade;

  /** Whether the relationship is required. Default: false */
  required?: boolean;
  /** Semantic metadata for AI reasoning and ontology search (Spec 67) */
  semantics?: RelationSemantics;
}

// ── Relation info (directional view) ──────────────────────────────────────────

export interface RelationInfo {
  /** The underlying relation definition */
  relation: RelationDefinition;

  /** Direction relative to the querying entity */
  direction: "outgoing" | "incoming";

  /** The entity on the other end */
  relatedEntity: string;

  /** Semantic name for this direction (fromName or toName) */
  semanticName: string;

  /** Display label for this direction (from label or semanticName fallback) */
  label: string;
}

// ── Relation registry interface ──────────────────────────────────────────

export interface RelationRegistryInterface {
  /** Register a relation definition */
  register(relation: RelationDefinition): void;

  /** Get all relations for an entity (both outgoing and incoming) */
  relationsFor(entityName: string): RelationInfo[];

  /** Get all relations between two entities (may return multiple) */
  relationsBetween(from: string, to: string): RelationDefinition[];

  /** Find a relation by semantic name on an entity */
  relationByName(entityName: string, semanticName: string): RelationInfo | null;

  /** Get all outgoing relations from an entity */
  outgoingRelations(entityName: string): RelationDefinition[];

  /** Get all incoming relations to an entity */
  incomingRelations(entityName: string): RelationDefinition[];

  /** List all registered relations */
  list(): RelationDefinition[];
}
