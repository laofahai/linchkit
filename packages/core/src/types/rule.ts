/**
 * Rule type definitions
 *
 * Rule is the business rule layer of the system. Event-driven independent adjudicators.
 * Rule = Trigger + Context (optional) + Condition + Effect
 */

import type { ExecutionMeta } from "./execution-meta";
import type { RuleSemantics } from "./meta-semantics";

// ── Comparison operators ──────────────────────────────────────

export type ComparisonOperator =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in"
  | "not_in"
  | "is_null"
  | "not_null"
  | "contains"
  | "notContains"
  | "between"
  | "notBetween"
  | "startsWith"
  | "endsWith"
  | "includesAll"
  | "excludesAny";

// ── Declarative conditions ──────────────────────────────────────

export interface SimpleCondition {
  field: string;
  operator: ComparisonOperator;
  value?: unknown;
}

export interface CompositeCondition {
  operator: "and" | "or";
  conditions: Array<SimpleCondition | CompositeCondition | NotCondition>;
}

export interface NotCondition {
  operator: "not";
  condition: SimpleCondition | CompositeCondition;
}

export type DeclarativeCondition = SimpleCondition | CompositeCondition | NotCondition;

// ── Code-based conditions ──────────────────────────────────────

export interface RuleConditionContext {
  target: Record<string, unknown>;
  context: Record<string, unknown>;
  actor: { type: string; id: string; groups: string[] };
  /**
   * Current execution meta (Spec 65 §6). Code-based conditions can branch
   * on caller hints (`bulk`, `dry_run`, `_channel`, …) the same way
   * declarative `meta.*` field paths can.
   */
  meta?: ExecutionMeta;
  /** AbortSignal propagated when a timeout is configured */
  signal?: AbortSignal;
}

export type CodeCondition = (ctx: RuleConditionContext) => boolean | Promise<boolean>;

// ── Trigger types ────────────────────────────────────

export interface ActionTrigger {
  action: string | string[];
}

export interface StateChangeTrigger {
  stateChange: {
    entity: string;
    from?: string;
    to?: string;
  };
}

export interface FieldChangeTrigger {
  fieldChange: {
    entity: string;
    field: string;
  };
}

export interface EventTrigger {
  event: string;
}

export interface ScheduleTrigger {
  schedule: string; // cron expression
}

export type RuleTrigger =
  | ActionTrigger
  | StateChangeTrigger
  | FieldChangeTrigger
  | EventTrigger
  | ScheduleTrigger;

// ── Effect types ─────────────────────────────────────

export interface BlockEffect {
  type: "block";
  message: string;
  reason?: string;
}

export interface WarnEffect {
  type: "warn";
  message: string;
}

export interface RequireApprovalEffect {
  type: "require_approval";
  level: string;
  message?: string;
}

export interface EnrichEffect {
  type: "enrich";
  setFields: Record<string, unknown>;
}

export interface ExecuteActionEffect {
  type: "execute_action";
  action: string;
  params?: Record<string, unknown>;
}

/**
 * Start a durable Flow as a post-commit side effect of the rule firing
 * (Spec 23 §1.1 / Spec 26 §2.2 — eventual-consistency, fire-and-forget). The
 * Flow owns its own Saga / failure policy; it is NOT compensation-coupled to the
 * action that triggered it. `input` defaults to the triggering action's input.
 */
export interface TriggerFlowEffect {
  type: "trigger_flow";
  flow: string;
  input?: Record<string, unknown>;
}

export type RuleEffect =
  | BlockEffect
  | WarnEffect
  | RequireApprovalEffect
  | EnrichEffect
  | ExecuteActionEffect
  | TriggerFlowEffect;

// ── Context query (M1+) ────────────────────────────

export interface ContextQuery {
  query: string;
  filter?: Record<string, unknown>;
  aggregate?: {
    sum?: string;
    count?: boolean;
    avg?: string;
    min?: string;
    max?: string;
  };
}

export type RuleContext = Record<string, ContextQuery>;

// ── Rule definition ──────────────────────────────────────

export interface RuleDefinition {
  name: string;
  label: string;
  description?: string;
  /** Allow tenant-level override (Layer 2 runtime override per spec 02) */
  overridable?: boolean;
  priority?: number;

  trigger: RuleTrigger;
  context?: RuleContext;
  condition: DeclarativeCondition | CodeCondition;
  effect: RuleEffect;
  /** Semantic metadata for AI reasoning and ontology search (Spec 67) */
  semantics?: RuleSemantics;
}

// ── Rule evaluation result ──────────────────────────────────

export interface RuleEvaluationResult {
  rule: string;
  triggered: boolean;
  effect: RuleEffect | null;
  duration: number;
  /** Error message if the rule's condition threw an exception */
  error?: string;
  /** Whether the rule was skipped (e.g., after approval was granted) */
  skipped?: boolean;
}

// ── Rule override (for Bridge) ─────────────────────────

export interface RuleOverride {
  condition?: DeclarativeCondition | CodeCondition;
  effect?: RuleEffect;
  trigger?: RuleTrigger;
  priority?: number;
}
