/**
 * Action type definitions
 *
 * Action is the sole write entry point of the system. UI / API / AI all mutate system state through Actions.
 * Actions are not CRUD — they are controlled execution units with business semantics.
 */

import type { ConfigRegistry } from "../config/config-registry";
import type { AIService } from "./ai";
import type { Logger } from "./logger";
import type { FieldDefinition } from "./entity";

// ── Actor types ──────────────────────────────────────

export type ActorType = "human" | "ai" | "system" | "worker" | "timer" | "external";

export interface Actor {
  type: ActorType;
  id: string;
  name?: string;
  groups: string[];
  tenantId?: string;
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

// ── Tenant context ───────────────────────────────────────

/** Tenant execution context for multi-tenant scoping (spec 30) */
export interface TenantContext {
  tenantId: string;
  /** Tenant-specific config overrides (loaded from tenant_overrides) */
  overrides?: Record<string, unknown>;
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

  /** Current tenant ID from execution context */
  tenantId?: string;

  /** Logger instance for action handlers */
  logger: Logger;

  /** AbortSignal for cancellation/timeout support */
  signal?: AbortSignal;

  /** AI service — optional, throws if not configured */
  ai: AIService;

  // Data operations
  get(
    schema: string,
    id: string,
    options?: { includeDeleted?: boolean },
  ): Promise<Record<string, unknown>>;
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

  /** Config registry — type-safe access to all validated config */
  config: ConfigRegistry;

  /** Check whether a capability is installed (weak dependency degradation) */
  hasCapability(name: string): boolean;

  // Current execution info
  executionId: string;
  timestamp: Date;
}

// ── Action AI configuration ─────────────────────────────────

/**
 * Per-action AI behavior configuration (spec 52 §2.4).
 * Controls how AI interacts with this action.
 */
export interface ActionAIConfig {
  /** Confirmation mode. 'explicit' (default): user must click Execute. 'auto': execute without confirmation for read-only queries. */
  confirmationMode?: "explicit" | "auto";
  /** When true, prevents AI from auto-executing this action even in auto mode */
  allowAutoExecute?: boolean;
  /** Hints to help AI understand this action's purpose and usage */
  promptHints?: string[];
}

// ── Intent resolution ─────────────────────────────────────

/**
 * Result of AI natural language intent resolution (spec 52 §2.2).
 * Represents what the AI understood from a user's natural language message.
 */
export interface IntentResolution {
  /** Matched action name, or null if no match */
  action: string | null;
  /** Target entity (inferred from action) */
  entity: string | null;
  /** Extracted input parameters */
  input: Record<string, unknown>;
  /** Fields that are required but not extracted */
  missingFields: string[];
  /** Confidence score 0-1 */
  confidence: number;
  /** Human-readable explanation of what will happen */
  explanation: string;
  /** Alternative interpretations if confidence < threshold */
  alternatives?: Array<{
    action: string;
    confidence: number;
    explanation: string;
  }>;
}

// ── Action permissions ─────────────────────────────────────

export interface ActionPermissions {
  groups?: string[];
  actorTypes?: ActorType[];
}

// ── Action definition ─────────────────────────────────────

export interface ActionDefinition {
  name: string;
  entity: string;
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
  /** AI behavior configuration for this action (spec 52 §2.4) */
  ai?: ActionAIConfig;
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
