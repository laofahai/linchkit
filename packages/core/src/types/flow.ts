/**
 * Flow type definitions
 *
 * Flow orchestrates multi-step business processes (e.g., purchase approval → manager review
 * → finance check → notify). Flows are event-driven, support branching, parallel execution,
 * human approval gates, and AI completion steps.
 */

import type { FlowSemantics } from "./meta-semantics";

// ── Flow triggers ──────────────────────────────────────

/** Triggered by an internal event (e.g., "action.succeeded") */
export interface EventFlowTrigger {
  type: "event";
  /** Event type name to listen for */
  eventType: string;
  /** Optional filter applied to the event payload */
  filter?: Record<string, unknown>;
}

/** Triggered by an explicit API call */
export interface ManualFlowTrigger {
  type: "manual";
}

/** Triggered on a cron schedule */
export interface ScheduleFlowTrigger {
  type: "schedule";
  /** Cron expression (e.g., "0 9 * * MON") */
  cron: string;
}

export type FlowTrigger = EventFlowTrigger | ManualFlowTrigger | ScheduleFlowTrigger;

// ── Flow step types ────────────────────────────────────

/** Common fields shared by all step types */
interface FlowStepBase {
  /** Unique step identifier within the flow */
  id: string;
  /** Human-readable step name */
  name: string;
  /** Optional description */
  description?: string;
}

/** Retry policy for a single action step */
export interface StepRetryPolicy {
  /** Maximum number of retry attempts (default: 0 — no retries) */
  maxAttempts: number;
  /** Initial delay between retries in milliseconds (default: 1000) */
  initialDelayMs?: number;
  /** Backoff multiplier applied to delay after each attempt (default: 2) */
  backoffMultiplier?: number;
  /** Maximum delay cap in milliseconds (default: 30000) */
  maxDelayMs?: number;
}

/** Execute a LinchKit action */
export interface ActionFlowStep extends FlowStepBase {
  type: "action";
  /** Name of the action to execute */
  actionName: string;
  /** Static input object, or expression string (e.g., "$prev.output.id") */
  input?: Record<string, unknown> | string;
  /** Compensation action to run if a later step fails (Saga pattern) */
  compensation?: string;
  /** Input for the compensation action; defaults to the step's own output */
  compensationInput?: Record<string, unknown> | string;
  /** Per-step retry policy (overrides flow-level maxRetries for this step) */
  retryPolicy?: StepRetryPolicy;
}

/** Wait for human approval */
export interface ApprovalFlowStep extends FlowStepBase {
  type: "approval";
  /** Group names of eligible approvers */
  approvers: string[];
  /** Timeout in milliseconds */
  timeout?: number;
  /** Behavior when approval times out */
  onTimeout?: "reject" | "escalate" | "skip";
  /** Step ID to jump to when approval is rejected (default: flow terminates) */
  onRejection?: string;
}

/** Conditional branching */
export interface ConditionFlowStep extends FlowStepBase {
  type: "condition";
  /** Expression to evaluate (e.g., "$prev.output.amount > 10000") */
  expression: string;
  /** Step ID to jump to when expression is truthy */
  then: string;
  /** Step ID to jump to when expression is falsy */
  else?: string;
}

/** AI completion step */
export interface AIFlowStep extends FlowStepBase {
  type: "ai";
  /** Prompt text or template with variables */
  prompt: string | { template: string; variables: Record<string, string> };
  /** Model alias (e.g., "fast", "standard", "advanced") */
  model?: string;
  /** Action names to expose as tools to the AI */
  tools?: string[];
  /** Constrain AI response to a JSON schema */
  responseFormat?: { type: "json"; schema: string };
}

/** Pause for a duration or wait for an external signal */
export interface WaitFlowStep extends FlowStepBase {
  type: "wait";
  /** Duration to wait in milliseconds */
  duration?: number;
  /** External signal name to wait for */
  signal?: string;
}

/** Execute multiple steps concurrently */
export interface ParallelFlowStep extends FlowStepBase {
  type: "parallel";
  /** Step IDs to execute in parallel */
  steps: string[];
  /** Whether to wait for all steps or just the first to complete */
  joinType?: "all" | "any";
}

export type FlowStep =
  | ActionFlowStep
  | ApprovalFlowStep
  | ConditionFlowStep
  | AIFlowStep
  | WaitFlowStep
  | ParallelFlowStep;

// ── Flow definition ────────────────────────────────────

/** Complete flow definition describing a multi-step business process */
export interface FlowDefinition {
  /** Unique flow name */
  name: string;
  /** Human-readable label */
  label?: string;
  /** Optional description */
  description?: string;
  /** Flow definition version */
  version?: number;

  /** How the flow is triggered */
  trigger: FlowTrigger;
  /** Ordered list of steps */
  steps: FlowStep[];

  /** Error handling strategy for the entire flow */
  onError?: "abort" | "retry" | "compensate";
  /**
   * Saga failure policy (Spec 26 §1.2).
   *
   * - `compensate` — when a step fails, run the compensating Action of each
   *   previously-completed step in reverse order (Saga pattern).
   * - `fail_fast` — propagate the original error without compensation
   *   (current default behaviour for backward compatibility).
   *
   * Optional. When set, takes precedence over the legacy `onError`
   * value for compensation decisions; otherwise `onError === "compensate"`
   * still triggers Saga rollback so existing flows keep working.
   */
  failurePolicy?: "compensate" | "fail_fast";
  /** Maximum retry attempts (applies when onError is "retry") */
  maxRetries?: number;
  /** Timeout for the entire flow in milliseconds */
  timeout?: number;

  /** Explicit chaining: trigger downstream flow(s) on completion */
  onComplete?: FlowChainConfig | FlowChainConfig[];
  /** Semantic metadata for AI reasoning and ontology search (Spec 67) */
  semantics?: FlowSemantics;
}

/** Configuration for explicit flow chaining */
export interface FlowChainConfig {
  /** Name of the downstream flow to trigger */
  flow: string;
  /** Map upstream output fields to downstream input fields.
   *  Keys are downstream input field names, values are expressions
   *  (e.g., "$result.orderId" or "$context.amount") */
  inputMapping?: Record<string, string>;
  /** Only chain on specific status (default: "completed") */
  onStatus?: "completed" | "failed";
}

// ── Compensation log ───────────────────────────────────

/** Result of a single compensation action execution */
export interface CompensationLogEntry {
  /** Step ID whose compensation was executed */
  stepId: string;
  /** Name of the compensation action that was invoked */
  compensationAction: string;
  /** Whether the compensation succeeded */
  status: "succeeded" | "failed";
  /** Error message if compensation failed */
  error?: string;
  /** When the compensation was executed */
  executedAt: Date;
}

// ── Flow instance (runtime state) ──────────────────────

/** Status of a flow instance */
export type FlowInstanceStatus =
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "compensating"
  | "compensated";

/** Runtime state of a flow instance */
export interface FlowInstance {
  /** Unique instance identifier */
  id: string;
  /** Name of the flow definition this instance is running */
  flowName: string;
  /** Current execution status */
  status: FlowInstanceStatus;
  /** ID of the step currently being executed */
  currentStepId: string;
  /** Accumulated data from completed steps */
  context: Record<string, unknown>;
  /** When the instance was started */
  startedAt: Date;
  /** When the instance completed (if finished) */
  completedAt?: Date;
  /** Error details if the instance failed */
  error?: { stepId: string; message: string };
  /** Log of compensation actions executed during Saga rollback */
  compensationLog?: CompensationLogEntry[];
}
