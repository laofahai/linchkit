/**
 * Semantic relation types — spec 24 §2.2
 *
 * Describes business-meaningful relationships between capabilities and schemas.
 * These are inferred automatically at startup from capability definitions,
 * or defined manually for implicit relationships the framework cannot detect.
 */

// ── Semantic relation types ──────────────────────────────

/**
 * All possible semantic relation types.
 * Auto-inferred types come from scanning capability definitions.
 * Manual types must be declared explicitly via defineSemanticRelation().
 */
export type SemanticRelationType =
  | "depends_on" // A depends on B existing (from capability.dependencies)
  | "contains" // A contains B records (manual — entity relations use defineRelation())
  | "references" // A references B (manual — entity relations use defineRelation())
  | "affects" // A changes affect B (from Bridge/EventHandler cross-module)
  | "triggers" // A triggers events in B (from EventHandler cross-module)
  | "orchestrates" // A orchestrates B actions (from Flow cross-module steps)
  | "reads_from" // A reads B data (from Rule context queries)
  | "bridges" // A bridges B (from Bridge capability.bridges)
  | "conflicts_with" // A and B conflict (manual only)
  | "replaces" // A replaces B (manual only)
  | "derived_from"; // A derives from B (manual only)

/** Source of inference — which mechanism detected this relation */
export type SemanticRelationSource =
  | "capability_dependency"
  | "bridge_definition"
  | "event_handler"
  | "flow_step"
  | "rule_context"
  | "manual";

// ── Semantic relation endpoint ──────────────────────────

/** One endpoint of a semantic relation */
export interface SemanticRelationEndpoint {
  /** Capability name */
  capability?: string;
  /** Entity name (optional — capability-level relations omit this) */
  entity?: string;
}

// ── Semantic relation ────────────────────────────────────

export interface SemanticRelation {
  /** Unique identifier for this relation */
  id: string;
  /** Type of semantic relationship */
  type: SemanticRelationType;
  /** Source side of the relation */
  from: SemanticRelationEndpoint;
  /** Target side of the relation */
  to: SemanticRelationEndpoint;
  /** Human-readable description */
  description?: string;
  /** How this relation was discovered */
  source: SemanticRelationSource;
  /** Reference to the construct that caused the inference (handler name, flow name, rule name, etc.) */
  inferredFrom?: string;
}

// ── defineRelation helper ────────────────────────────────

/**
 * Define a manual semantic relation that the framework cannot auto-infer.
 * Only use this for implicit business semantics (e.g., conflicts_with, replaces, derived_from).
 */
export function defineSemanticRelation(
  def: Omit<SemanticRelation, "id" | "source"> & { source?: SemanticRelationSource },
): SemanticRelation {
  const fromKey = [def.from.capability ?? "", def.from.entity ?? ""].join(":");
  const toKey = [def.to.capability ?? "", def.to.entity ?? ""].join(":");
  return {
    id: `${fromKey}->${def.type}->${toKey}`,
    source: "manual",
    ...def,
  };
}

// ── RelationGraph ────────────────────────────────────────

/** In-memory relation graph — built once at startup */
export interface RelationGraph {
  /** All inferred + manual semantic relations */
  relations: SemanticRelation[];
  /** Find all relations originating from a capability or schema */
  outgoing(endpoint: SemanticRelationEndpoint): SemanticRelation[];
  /** Find all relations pointing to a capability or schema */
  incoming(endpoint: SemanticRelationEndpoint): SemanticRelation[];
  /** Find all relations involving a capability (either direction) */
  forCapability(capabilityName: string): SemanticRelation[];
  /** Find all relations involving a schema (either direction) */
  forEntity(entityName: string): SemanticRelation[];
}
