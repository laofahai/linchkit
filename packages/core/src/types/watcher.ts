/**
 * Watcher type definitions
 *
 * Data-condition-triggered automation (spec 45).
 * Watchers observe aggregated/individual data conditions and fire effects
 * when thresholds are crossed, records go stale, sets change, or schedules match.
 */

import type { DeclarativeCondition } from "./rule";

// ── Comparison condition (threshold) ──────────────────────

/** Simple numeric comparison used in trigger.condition */
export interface WatcherComparisonCondition {
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
  eq?: number;
}

// ── Watch target ──────────────────────────────────────────

export interface WatcherAggregateConfig {
  /** Field to aggregate */
  field: string;
  /** Aggregation operator */
  op: "sum" | "count" | "avg" | "min" | "max";
  /** Group aggregation by this field */
  groupBy?: string;
}

export interface WatchTarget {
  /** Entity name to watch */
  entity: string;
  /** Optional declarative filter on records */
  filter?: DeclarativeCondition;
  /** Optional aggregation config (omit for single-record watchers) */
  aggregate?: WatcherAggregateConfig;
}

// ── Trigger types ─────────────────────────────────────────

/** Debounce strategy to prevent repeated firing */
export type WatcherDebounce = "once_until_reset" | "once_per_record" | "cooldown";

/** Threshold trigger: fires when a field or aggregate crosses a boundary */
export interface ThresholdWatcherTrigger {
  type: "threshold";
  /** Field to compare (for single-record watchers). Ignored when aggregate is set. */
  field?: string;
  /** Numeric comparison condition */
  condition: WatcherComparisonCondition;
  /** Debounce strategy */
  debounce?: WatcherDebounce;
  /** Cooldown period (e.g. '1h', '30m'). Only used with debounce='cooldown'. */
  cooldownPeriod?: string;
}

/** Staleness trigger: fires when a timestamp field is older than threshold */
export interface StalenessWatcherTrigger {
  type: "staleness";
  /** Timestamp field to check (e.g. 'updated_at') */
  field: string;
  /** Duration string (e.g. '48h', '7d', '30m') */
  threshold: string;
  /** Debounce strategy */
  debounce?: WatcherDebounce;
  /** Cooldown period */
  cooldownPeriod?: string;
}

/** Schedule trigger: evaluates condition on a cron schedule */
export interface ScheduleWatcherTrigger {
  type: "schedule";
  /** Cron expression */
  cron: string;
  /** Optional condition that must also be met */
  condition?: { count?: WatcherComparisonCondition };
  /** Debounce strategy */
  debounce?: WatcherDebounce;
  /** Cooldown period */
  cooldownPeriod?: string;
}

/** Set-change trigger: fires when records enter/leave a filtered set */
export interface SetChangeWatcherTrigger {
  type: "set_change";
  /** Which change to watch */
  on: "added" | "removed" | "modified";
  /** Debounce strategy */
  debounce?: WatcherDebounce;
  /** Cooldown period */
  cooldownPeriod?: string;
}

export type WatcherTrigger =
  | ThresholdWatcherTrigger
  | StalenessWatcherTrigger
  | ScheduleWatcherTrigger
  | SetChangeWatcherTrigger;

// ── Watcher context (passed to effect.params functions) ───

export interface WatcherContext {
  /** The individual record that matched (single-record watchers) */
  record?: Record<string, unknown>;
  /** All matching records */
  records?: Array<Record<string, unknown>>;
  /** Aggregate value (when aggregate is configured) */
  value?: number;
  /** Group key (when groupBy is configured) */
  group?: Record<string, unknown>;
  /** Count of matching records */
  count?: number;
  /** The watcher name */
  watcherName: string;
  /** Tenant ID */
  tenantId?: string;
}

// ── Watcher effect ────────────────────────────────────────

export interface WatcherEffect {
  /** Action name to execute */
  action: string;
  /** Static params or dynamic params function */
  params: Record<string, unknown> | ((ctx: WatcherContext) => Record<string, unknown>);
}

// ── Watcher definition ───────────────────────────────────

export interface WatcherDefinition {
  /** Unique watcher name */
  name: string;
  /** Human-readable label */
  label?: string;
  /** Description */
  description?: string;
  /** What data to watch */
  watch: WatchTarget;
  /** When to trigger */
  trigger: WatcherTrigger;
  /** What to do */
  effect: WatcherEffect;
  /** Whether the watcher is active (default: true) */
  enabled: boolean;
  /** Whether to scope evaluation by tenant (default: true) */
  tenantScoped?: boolean;
}

// ── Watcher state (for debounce tracking) ─────────────────

export interface WatcherStateEntry {
  /** Watcher identifier */
  watcherName: string;
  /** Group key or record ID */
  groupKey: string;
  /** Last time the watcher fired */
  lastFiredAt: Date | null;
  /** Whether the condition is currently met */
  conditionMet: boolean;
  /** Tenant ID */
  tenantId?: string;
}

// ── Watcher evaluation result ─────────────────────────────

export interface WatcherEvaluationResult {
  /** Watcher that was evaluated */
  watcherName: string;
  /** Whether the effect was fired */
  fired: boolean;
  /** Reason if not fired */
  reason?: string;
  /** Error if evaluation failed */
  error?: string;
}
