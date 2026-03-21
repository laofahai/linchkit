/**
 * Action type definitions
 *
 * Action is the sole write entry point of the system. UI / API / AI all mutate system state through Actions.
 * Actions are not CRUD — they are controlled execution units with business semantics.
 */

import type { FieldDefinition } from "./schema";

// ── Actor types ──────────────────────────────────────

export type ActorType = "human" | "ai" | "system" | "worker" | "timer" | "external";

export interface Actor {
  type: ActorType;
  id: string;
  name?: string;
  groups: string[];
  metadata?: Record<string, unknown>;
}

// ── Action execution policy ────────────────────────────────

export interface ActionPolicy {
  mode: "sync" | "async";
  transaction: boolean;
  idempotent?: boolean;
  failurePolicy?: "fail" | "retry" | "compensate";
  retryConfig?: {
    maxRetries: number;
    backoff: "fixed" | "exponential";
  };
}

// ── Action resource limits ────────────────────────────────

export interface ActionLimits {
  maxExecutionTime?: number;
  maxDbOperations?: number;
  maxEvents?: number;
  maxChildActions?: number;
}

// ── Action exposure control ─────────────────────────────

export interface ActionExposure {
  http?: boolean;
  mcp?: boolean;
  cli?: boolean;
  ui?: boolean;
  internal?: boolean;
}

// ── Action side effect declarations ───────────────────────────────

export interface ActionSideEffect {
  type: "state_change" | "create" | "update" | "delete" | "execute_action" | "emit_event";
  target: string;
  description?: string;
}

// ── Action state transition ─────────────────────────────────

export interface StateTransition {
  from: string | string[];
  to: string;
}

// ── Action pre-validation ─────────────────────────────────

export interface ActionValidation {
  required?: string[];
  custom?: (ctx: ActionContext) => ValidationResult;
}

export interface ValidationResult {
  valid: boolean;
  errors?: Array<{ field: string; message: string }>;
}

// ── ActionContext ────────────────────────────────────

export interface ActionContext {
  input: Record<string, unknown>;
  actor: Actor;

  // Data operations
  get(schema: string, id: string): Promise<Record<string, unknown>>;
  query(schema: string, filter: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
  create(schema: string, data: Record<string, unknown>): Promise<Record<string, unknown>>;
  update(
    schema: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  delete(schema: string, id: string): Promise<void>;

  // Trigger other Actions
  execute(actionName: string, input: Record<string, unknown>): Promise<unknown>;

  // Emit custom events
  emit(eventType: string, payload: Record<string, unknown>): void;

  // Current execution info
  executionId: string;
  timestamp: Date;
}

// ── Action permissions ─────────────────────────────────────

export interface ActionPermissions {
  groups?: string[];
  actorTypes?: ActorType[];
}

// ── Action definition ─────────────────────────────────────

export interface ActionDefinition {
  name: string;
  schema: string;
  label: string;
  description?: string;

  input?: Record<string, FieldDefinition>;
  output?: Record<string, FieldDefinition>;

  validate?: ActionValidation;
  stateTransition?: StateTransition;
  setFields?: Record<string, unknown>;

  handler?: (ctx: ActionContext) => Promise<unknown>;

  policy: ActionPolicy;
  limits?: ActionLimits;
  sideEffects?: ActionSideEffect[];
  exposure?: ActionExposure | "all";
  permissions?: ActionPermissions;
}

// ── Action execution result ─────────────────────────────────

export interface ActionResult<T = unknown> {
  success: boolean;
  data?: T;
  record?: Record<string, unknown>;
  warnings?: string[];
  executionId: string;
}

// ── Action override (for Bridge) ─────────────────────────

export interface ActionOverride {
  before?: (ctx: ActionContext) => Promise<void>;
  after?: (ctx: ActionContext) => Promise<void>;
  handler?: (ctx: ActionContext) => Promise<unknown>;
  policy?: Partial<ActionPolicy>;
}
