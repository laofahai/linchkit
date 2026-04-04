/**
 * Life-System Type Abstractions — Spec 55
 *
 * Core interfaces for the five-layer life-system:
 * Sense → Memory → Awareness → Insight → Proposal
 *
 * These are abstract contracts. Concrete implementations live in capabilities.
 */

// ── Signal sources (Spec 55 §3.1) ──────────────────────────

/** Channels through which signals enter the system. */
export type SignalSource = "event_bus" | "server" | "api" | "graphql" | "mcp" | "ui";

// ── Sense layer ─────────────────────────────────────────────

/**
 * A raw observation emitted by a Sensor.
 * Flows into Memory for aggregation and baseline computation.
 */
export interface Signal {
  type: string;
  source: SignalSource;
  timestamp: Date;
  payload: unknown;
}

/**
 * Standardized sensor output (Spec 55 §3.4).
 * All sensors output this format before signals flow to SignalBus.
 */
export interface SensorSignal {
  /** Name of the sensor that emitted this signal. */
  sensor: string;
  source: SignalSource;
  timestamp: Date;
  /** Current observed value. */
  value: number;
  /** Memory-computed baseline value for comparison. */
  baseline: number;
  /** Deviation from baseline, normalized 0–1. */
  deviation: number;
  /** Signal confidence, 0–1. Higher = more trustworthy. */
  confidence: number;
  context: Record<string, unknown>;
}

/**
 * Context provided to a Sensor during detection.
 * Gives sensors access to runtime data without coupling to specific stores.
 */
export interface SensorContext {
  tenantId?: string;
  timestamp: Date;
  /** Optional data-query helper — allows sensors to look up records. */
  query?: <T = unknown>(schema: string, filter?: Record<string, unknown>) => Promise<T[]>;
}

/**
 * Sensor interface — detection unit for the Sense layer (Spec 55 §3.3).
 *
 * Sensors are Capability-registered, not hard-coded in core. Each sensor
 * targets a specific signal source and optionally a specific schema.
 */
export interface Sensor<TSignal = SensorSignal> {
  /** Unique sensor name within a capability. */
  name: string;
  /** Which system channel this sensor observes. */
  source: SignalSource;
  /** Entity this sensor is scoped to, if any. */
  entity?: string;
  detect(context: SensorContext): Promise<TSignal | null>;
}

// ── Memory layer ────────────────────────────────────────────

/**
 * Baseline for a single (schema, metric) pair (Spec 55 §4.2 / Spec 56 §Phase2a).
 * Used by Sensors to compute `deviation` and by Awareness to rank importance.
 */
export interface Baseline {
  entity: string;
  metric: string;
  value: number;
  calculatedAt: Date;
}

/**
 * Memory store interface — persistent layer for signals and baselines.
 * Concrete implementations provided by capabilities (e.g. cap-memory-drizzle).
 */
export interface MemoryStore {
  recordSignal(signal: Signal): Promise<void>;
  getBaseline(schema: string, metric: string): Promise<Baseline | null>;
  updateBaseline(baseline: Baseline): Promise<void>;
}

// ── Awareness layer ─────────────────────────────────────────

/**
 * Abstract Detector interface — retained in core as an Awareness-layer contract.
 *
 * Concrete implementations (PatternDetector, AnomalyDetector) may live in
 * capabilities. Core keeps this interface so engines can depend on the abstraction
 * without coupling to specific detection algorithms.
 */
export interface Detector<TEvent = unknown, TResult = unknown> {
  detect(events: TEvent[]): Promise<TResult[]>;
}

// -- SignalBus --
export interface SignalBus {
  emit(signal: SensorSignal): void;
  subscribe(listener: (signal: SensorSignal) => void): () => void;
}

// -- Usage Importance Graph (Spec 55 §5.2) --
export type UsageNodeKind = "schema" | "action" | "field";

export interface UsageNode {
  kind: UsageNodeKind;
  entity: string;
  name?: string;
  importance: number;
  usageCount: number;
  lastAccessed: Date;
}

export interface UsageImportanceGraph {
  recordUsage(kind: UsageNodeKind, entity: string, name?: string): void;
  getImportance(kind: UsageNodeKind, entity: string, name?: string): number;
  topN(n: number, kind?: UsageNodeKind): UsageNode[];
  nodesFor(entity: string): UsageNode[];
  toArray(): UsageNode[];
}

// -- Attention Budget (Spec 55 §6.3) --
export interface AttentionBudgetConfig {
  maxInsightsPerCycle: number;
  ignoreDecay: number;
  endorseBoost: number;
}

export interface ScoredCandidate<T = unknown> {
  item: T;
  score: number;
  breakdown: { confidence: number; impact: number; importance: number; typeWeight: number };
}

export interface AttentionBudget {
  rank<T>(
    candidates: Array<{
      item: T;
      confidence: number;
      impact: number;
      entity?: string;
      type?: string;
    }>,
  ): ScoredCandidate<T>[];
  recordIgnore(type: string): void;
  recordEndorse(type: string): void;
}

// -- Structural Check (Spec 55 §5.4) --
export type StructuralIssueKind =
  | "schema_no_view"
  | "action_never_called"
  | "link_no_records"
  | "rule_never_triggered"
  | "field_constant_value";

export interface StructuralIssue {
  kind: StructuralIssueKind;
  entity: string;
  target?: string;
  message: string;
}

// -- AwarenessEngine (Spec 55 §5) --
export interface AwarenessEngine {
  readonly usageGraph: UsageImportanceGraph;
  readonly attentionBudget: AttentionBudget;
  structuralCheck(): StructuralIssue[];
  ingestSignal(signal: SensorSignal): void;
}
