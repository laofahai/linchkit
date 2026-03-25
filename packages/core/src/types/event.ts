/**
 * Event type definitions
 *
 * Events are the driving core of the system, connecting Action, Rule, State, and Execution.
 * Three event categories: Runtime Events, Change Events, Custom Events.
 */

// ── Event categories ────────────────────────────────────────

export type EventCategory = "runtime" | "change" | "custom";

// ── Event definition (for custom events) ─────────────────────────

export interface EventDefinition {
  name: string;
  label?: string;
  description?: string;
  category: "custom";
  payload?: Record<string, unknown>;
}

// ── Event record ────────────────────────────────────────

export interface EventRecord {
  id: string;
  type: string;
  category: EventCategory;
  timestamp: Date;

  actor: {
    type: string;
    id: string;
  };

  tenantId?: string;
  schema?: string;
  recordId?: string;
  action?: string;

  // Causal chain
  executionId: string;
  causedBy?: string;

  payload: Record<string, unknown>;
  capabilityVersion?: string;
}

// ── EventHandler types ───────────────────────────────

export interface RetryPolicy {
  maxRetries: number;
  backoff: "fixed" | "exponential";
  initialDelay?: number;
}

export interface EventHandlerDefinition {
  name: string;
  label?: string;
  description?: string;

  listen: string | string[];
  filter?: Record<string, unknown>;
  async?: boolean;
  priority?: number;
  retryPolicy?: RetryPolicy;

  handler: (event: EventRecord, ctx: EventHandlerContext) => Promise<void>;
}

// ── EventHandler Context ────────────────────────────

export interface EventHandlerContext {
  execute(actionName: string, input: Record<string, unknown>): Promise<unknown>;
  emit(eventType: string, payload: Record<string, unknown>): void;
  get(schema: string, id: string): Promise<Record<string, unknown>>;
  query(schema: string, filter: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
}

// ── EventBusLike interface ───────────────────────────────────
// Minimal event bus contract used by automation and flow modules
// to subscribe to events without depending on the full EventBus implementation.

export interface EventBusLike {
  subscribe(eventType: string, handler: (event: EventRecord) => Promise<void>): () => void;
}
