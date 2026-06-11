/**
 * Meta-model semantic metadata — Spec 67
 *
 * Structured semantic annotations that can be attached to any defineXxx() element.
 * Enables AI-driven conflict detection, impact analysis, and semantic search
 * without requiring vector storage (Phase 1 uses tag-based matching only).
 */

// ── Base semantic interface ───────────────────────────────────────────────────

/**
 * Shared semantic metadata for all meta-model elements.
 * All fields are optional — partial semantics are better than none.
 */
export interface MetaSemantics {
  /** Business intent categories: ['financial_control', 'compliance', 'automation'] */
  intent?: string[];
  /** Business domains: ['procurement', 'hr', 'inventory'] */
  domain?: string[];
  /** Standardised natural-language summary (human or AI-generated) */
  summary?: string;
  /** Free-form tags for search and grouping */
  tags?: string[];
}

// ── Type-specific semantic extensions ────────────────────────────────────────

/** Entity — business object classification */
export interface EntitySemantics extends MetaSemantics {
  /**
   * Entity category inferred at registration time if not explicitly set.
   * - transaction: entity with a state machine (has state transitions)
   * - reference: entity with no write actions (lookup/reference data)
   * - master_data: default for most entities
   * - log: append-only audit/log entity
   * - config: system configuration entity
   */
  category?: "master_data" | "transaction" | "reference" | "log" | "config";
  /** Data sensitivity level for access control and masking */
  sensitivity?: "public" | "internal" | "confidential" | "restricted";
}

/** Action — operation impact assessment */
export interface ActionSemantics extends MetaSemantics {
  /**
   * Side-effect scope inferred at registration time.
   * - none: pure read / no-op
   * - local: mutates only the action's own entity
   * - cross_entity: mutates other entities via sideEffects
   * - external: calls external APIs / services
   */
  sideEffectLevel?: "none" | "local" | "cross_entity" | "external";
  /**
   * Whether the action can be reversed via a compensating action.
   * Inferred from ActionPolicy.failurePolicy === 'compensate'.
   */
  reversible?: boolean;
}

/** Rule — governance and compliance */
export interface RuleSemantics extends MetaSemantics {
  /** Compliance regulation references: ['SOX-404', 'GDPR-Art17'] */
  regulation?: string[];
  /** Business risk level of this rule */
  riskLevel?: "low" | "medium" | "high" | "critical";
}

/** Flow — business process mapping */
export interface FlowSemantics extends MetaSemantics {
  /** Corresponding business process name */
  businessProcess?: string;
  /** Service-level agreement / time expectation: '24h', '3d' */
  sla?: string;
}

/** Relation — semantic meaning of the relationship */
export interface RelationSemantics extends MetaSemantics {
  /** Human-readable business meaning: 'Supplier supplies goods for a purchase order' */
  businessMeaning?: string;
}

// State, Event, EventHandler, View use the base MetaSemantics without extension

// ── MetaModelRef ─────────────────────────────────────────────────────────────

/** A typed reference to any meta-model element */
export type MetaModelElementType =
  | "entity"
  | "action"
  | "rule"
  | "state"
  | "event"
  | "event_handler"
  | "view"
  | "flow"
  | "relation";

export interface MetaModelRef {
  type: MetaModelElementType;
  name: string;
}

// ── MetaModelSemanticRelation ─────────────────────────────────────────────────

/** Inter-element semantic relationships (Spec 67 §2.3) */
export type MetaModelRelationType =
  | "subsumes" // A's condition subsumes B (A is broader)
  | "conflicts_with" // A and B have contradicting effects
  | "complements" // A complements B (fire together)
  | "overrides"; // A overrides B under specific conditions

export interface MetaModelSemanticRelation {
  from: MetaModelRef;
  to: MetaModelRef;
  relation: MetaModelRelationType;
  /** Confidence score 0-1; 1.0 for explicit declarations */
  confidence: number;
  /** How this relation was established */
  source: "explicit" | "inferred";
}

// ── Dependency DAG types ─────────────────────────────────────────────────────

/** Edge types in the dependency DAG (Spec 67 §4.1) */
export type DependencyEdgeType =
  | "field_read" // Rule.condition reads Entity.field
  | "field_write" // Action writes Entity.field
  | "triggers" // Rule.effect or EventHandler triggers Action
  | "guards" // State.transition guarded by Rule
  | "handles" // EventHandler handles Event
  | "contains" // Flow contains Action step
  | "references" // Action/Relation/View references Entity
  | "state_transition" // State.transition[].action references Action (State → Action)
  | "state_machine"; // Entity state field references its StateDefinition (Entity → State)

export interface DependencyEdge {
  from: MetaModelRef;
  to: MetaModelRef;
  type: DependencyEdgeType;
}

/** Subgraph returned by dependencyGraph() */
export interface DependencyGraph {
  /** Root node of this subgraph */
  root: MetaModelRef;
  /** All nodes reachable from root (includes root) */
  nodes: MetaModelRef[];
  /** All edges in the subgraph */
  edges: DependencyEdge[];
}

/** Impact analysis result: layers[0] = root, layers[1] = direct dependents, etc. */
export type ImpactLayers = MetaModelRef[][];
