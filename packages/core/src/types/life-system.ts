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
  /** Schema this sensor is scoped to, if any. */
  schema?: string;
  detect(context: SensorContext): Promise<TSignal | null>;
}

// ── Memory layer ────────────────────────────────────────────

/**
 * Baseline for a single (schema, metric) pair (Spec 55 §4.2 / Spec 56 §Phase2a).
 * Used by Sensors to compute `deviation` and by Awareness to rank importance.
 */
export interface Baseline {
  schema: string;
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
