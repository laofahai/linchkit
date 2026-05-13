/**
 * Event type definitions
 *
 * Events are the driving core of the system, connecting Action, Rule, State, and Execution.
 * Three event categories: Runtime Events, Change Events, Custom Events.
 */

import type { ExecutionMeta } from "./execution-meta";

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
  entity?: string;
  recordId?: string;
  action?: string;
  /** Source capability that produced this event */
  capability?: string;

  // Causal chain
  executionId: string;
  causedBy?: string;

  payload: Record<string, unknown>;
  capabilityVersion?: string;

  /**
   * Optional deduplication key. When set, EventBus will suppress a second
   * dispatch of the same key within the configured dedupWindow. If omitted,
   * the bus derives the key as `{executionId}:{type}` when dedup is enabled.
   */
  idempotencyKey?: string;

  /**
   * Execution metadata from the originating action (Spec 65 §7).
   * Delivery-time only — NOT persisted to the events table. EventBus reads
   * this to build the handler context's `ctx.meta`.
   */
  meta?: ExecutionMeta;
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
  emit(eventType: string, payload: Record<string, unknown>): void;
  /**
   * Execution metadata from the action that produced this event (Spec 65 §7).
   * For events emitted outside an action context (e.g., system events),
   * this is an empty `ExecutionMeta` so `ctx.meta.get(...)` returns
   * `undefined` rather than throwing.
   */
  meta: ExecutionMeta;
}

// ── Subscription event (SSE push to client) ────────────────

export type SubscriptionEventType =
  | "record.created"
  | "record.updated"
  | "record.deleted"
  | "state.changed"
  | "approval.resolved"
  | "entity.changed";

/** SSE event pushed to subscribed clients (spec 44) */
export interface SubscriptionEvent {
  type: SubscriptionEventType;
  entity: string;
  recordId: string;
  tenantId: string;
  /** Partial data — only changed fields, not the full record */
  changes?: Record<string, unknown>;
  /** State transition info (only for state.changed) */
  state?: { from: string; to: string; action: string };
  actor: { id: string; type: string };
  timestamp: string;
  executionId?: string;
}

// ── EventBusLike interface ───────────────────────────────────
// Minimal event bus contract used by automation and flow modules
// to subscribe to events without depending on the full EventBus implementation.

export interface EventBusLike {
  subscribe(eventType: string, handler: (event: EventRecord) => Promise<void>): () => void;
}
