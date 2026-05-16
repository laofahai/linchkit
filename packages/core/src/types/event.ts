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
  | "record.batch_created"
  | "record.batch_updated"
  | "record.batch_deleted"
  | "state.changed"
  | "approval.resolved"
  | "entity.changed";

/** SSE event for a single-record mutation (record.created / updated / deleted) */
export type RecordSubscriptionEvent = {
  type: "record.created" | "record.updated" | "record.deleted";
  entity: string;
  recordId: string;
  tenantId: string;
  actor: { id: string; type: string };
  timestamp: string;
  executionId?: string;
  /** Partial data — only changed fields, not the full record */
  changes?: Record<string, unknown>;
};

/** SSE event for a multi-record batch mutation (record.batch_created / updated / deleted) */
export type BatchRecordSubscriptionEvent = {
  type: "record.batch_created" | "record.batch_updated" | "record.batch_deleted";
  entity: string;
  recordIds: string[];
  count: number;
  /**
   * Per-record payloads from the original individual events, in original order.
   * Mirrors what the underlying `record.created/updated/deleted` events
   * carried, so subscribers can react to the batch without losing per-record
   * context (e.g., changed fields).
   */
  records: Array<Record<string, unknown>>;
  tenantId: string;
  actor: { id: string; type: string };
  timestamp: string;
  executionId?: string;
};

/** SSE event for a state-machine transition (state.changed). */
export type StateChangedSubscriptionEvent = {
  type: "state.changed";
  entity: string;
  recordId?: string;
  tenantId: string;
  actor: { id: string; type: string };
  timestamp: string;
  executionId?: string;
  /** State transition info — required for state.changed. */
  state: { from: string; to: string; action: string };
  changes?: Record<string, unknown>;
};

/** SSE event for an approval resolution (approval.resolved). */
export type ApprovalResolvedSubscriptionEvent = {
  type: "approval.resolved";
  entity: string;
  recordId?: string;
  tenantId: string;
  actor: { id: string; type: string };
  timestamp: string;
  executionId?: string;
  changes?: Record<string, unknown>;
};

/** SSE event for an entity-level change (entity.changed). */
export type EntityChangedSubscriptionEvent = {
  type: "entity.changed";
  entity: string;
  recordId?: string;
  tenantId: string;
  actor: { id: string; type: string };
  timestamp: string;
  executionId?: string;
  changes?: Record<string, unknown>;
};

/**
 * SSE event pushed to subscribed clients (spec 44).
 *
 * Discriminated union on `type` — narrow by `type` to access fields that
 * differ between single-record, batch, state, approval, and entity variants.
 */
export type SubscriptionEvent =
  | RecordSubscriptionEvent
  | BatchRecordSubscriptionEvent
  | StateChangedSubscriptionEvent
  | ApprovalResolvedSubscriptionEvent
  | EntityChangedSubscriptionEvent;

// ── EventBusLike interface ───────────────────────────────────
// Minimal event bus contract used by automation and flow modules
// to subscribe to events without depending on the full EventBus implementation.

export interface EventBusLike {
  subscribe(eventType: string, handler: (event: EventRecord) => Promise<void>): () => void;
}
