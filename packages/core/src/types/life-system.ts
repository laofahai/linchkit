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
 *
 * NOTE: A separate, lifecycle-style `LifecycleSensor` interface (with
 * `id`/`start`/`stop`/`subscribe`) lives in `life-system/abstractions.ts`
 * and forms the Spec 56 Phase 2 Step 2a forward-looking contract for
 * push-based sensors. Both styles co-exist — the detection-style `Sensor`
 * here powers `defineSensor()` and the existing EvolutionRuntime, while
 * the lifecycle-style `LifecycleSensor` is for capabilities that prefer
 * a push-based contract and register via `registerSensor()` from
 * `@linchkit/core` rather than `extensions.sensors`.
 *
 * @see ../life-system/abstractions.ts for the lifecycle-style {@link LifecycleSensor}.
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

// NOTE: The abstract `Detector` Awareness-layer contract now lives in
// `../life-system/detector.ts` (Spec 56 Phase 2 Step 2c) so it sits next
// to the other lifecycle abstractions. Import it via `@linchkit/core`.

// -- SignalBus --
export interface SignalBus {
  emit(signal: SensorSignal): void;
  subscribe(listener: (signal: SensorSignal) => void): () => void;
}

// -- Usage Importance Graph (Spec 55 §5.2) --
export type UsageNodeKind = "entity" | "action" | "field";

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

// ── Insight layer (Spec 55 §6) ─────────────────────────────

/** Insight types as defined in Spec 55 §6.2 */
export type InsightType = "anomaly" | "friction" | "pattern" | "structural" | "positive";

/** Causality annotation — distinguishes fact types (Spec 55 §6.1) */
export type InsightCausality = "causal" | "correlational" | "structural";

/** Impact level for prioritization */
export type InsightImpact = "low" | "medium" | "high";

/** Evidence pack attached to every Insight (Spec 55 §6.1) */
export interface InsightEvidence {
  signals: SensorSignal[];
  baseline?: Baseline;
  context: Record<string, unknown>;
  counterExamples?: unknown[];
}

/**
 * Insight — a fact with evidence, discovered by the system (Spec 55 §6).
 *
 * Insights are NOT suggestions. They are evidence-backed observations
 * that emerge from Awareness. AI is not needed to generate them.
 */
export interface Insight {
  id: string;
  type: InsightType;
  confidence: number;
  impact: InsightImpact;
  evidence: InsightEvidence;
  /** Human-readable summary of the finding */
  summary: string;
  causality: InsightCausality;
  /** Entity this insight relates to */
  entity: string;
  /** When this insight was generated */
  createdAt: Date;
}

/**
 * Promotion config — controls when signal candidates become Insights (Spec 55 §6.3).
 * "structural" insights skip promotion (one occurrence is enough).
 */
export interface InsightPromotionConfig {
  /** Minimum occurrences of the same pattern before promotion. Default: 3 */
  minOccurrences: number;
  /** Pattern must appear across at least N distinct contexts. Default: 2 */
  minDistinctContexts: number;
  /** Time window for counting occurrences (ms). Default: 30 days */
  timeWindowMs: number;
  /** Minimum confidence for promotion. Default: 0.7 */
  minConfidence: number;
}

/**
 * Options for InsightEngine.generateInsights (Spec 55 §6.3).
 *
 * When `budget` is provided, the engine ranks the freshly produced insights
 * by `confidence × impact × importance × typeWeight` and caps them at the
 * budget's `maxInsightsPerCycle`. Insights stored via promotion remain in
 * `getInsights()` regardless — the budget only controls what surfaces in
 * this cycle's return value.
 */
export interface GenerateInsightsOptions {
  /** Optional attention budget. Without it, all promoted insights surface. */
  budget?: AttentionBudget;
}

/**
 * InsightEngine — generates Insights from Awareness + Memory data (Spec 55 §6).
 */
export interface InsightEngine {
  /** Generate insights from current awareness state */
  generateInsights(opts?: GenerateInsightsOptions): Promise<Insight[]>;
  /** Record a drift event as an insight candidate */
  recordDriftCandidate(signal: SensorSignal, deviation: number): void;
  /** Get all promoted insights */
  getInsights(): Insight[];
}

// ── Evolution Cycle (Spec 55 §2.2) ────────────────────────

/** Result of a single evolution cycle run. */
export interface EvolutionCycleResult {
  signalsCollected: number;
  driftsDetected: number;
  newInsights: Insight[];
  totalInsights: number;
}

/**
 * EvolutionCycle — end-to-end orchestrator for Sense → Memory → Awareness → Insight.
 */
export interface EvolutionCycle {
  /** Execute one full cycle: collect → ingest → detect drift → generate insights */
  runCycle(ctx?: SensorContext): Promise<EvolutionCycleResult>;
  readonly insightEngine: InsightEngine;
  readonly awarenessEngine: AwarenessEngine;
}
