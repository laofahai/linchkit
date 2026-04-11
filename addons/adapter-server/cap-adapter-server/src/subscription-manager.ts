/**
 * SubscriptionManager — SSE-based realtime subscription system.
 *
 * Bridges EventBus events to per-client SSE streams with:
 * - Schema/record-level filtering
 * - Permission enforcement (tenant + schema read access)
 * - Heartbeat keep-alive
 * - Per-user connection limits
 * - Backpressure (buffer overflow → drop + warn)
 *
 * See spec 44 for full design.
 */

import type { Actor, EventBus, EventRecord, SubscriptionConfig } from "@linchkit/core";

// ── SubscriptionEvent — the wire format sent to clients ──────

export interface SubscriptionEvent {
  type:
    | "record.created"
    | "record.updated"
    | "record.deleted"
    | "state.changed"
    | "approval.resolved"
    | "entity.changed";

  entity: string;
  recordId: string;
  tenantId?: string;

  /** Partial data — only changed fields (not full record) */
  changes?: Record<string, unknown>;

  /** State transition info (only for state.changed) */
  state?: { from: string; to: string; action: string };

  actor: { id: string; type: string };
  timestamp: string;
  executionId?: string;

  /** Monotonic event ID for Last-Event-ID replay (set by SubscriptionManager) */
  eventId?: string;
}

// ── Subscription filter ──────────────────────────────────────

export interface SubscriptionFilter {
  /** Entity names to subscribe to (empty = all accessible entities) */
  entities: string[];
  /** Record IDs for fine-grained filtering (optional) */
  ids?: string[];
  /** Tenant ID for row-level isolation */
  tenantId?: string;
}

// ── Connection tracking ──────────────────────────────────────

interface SSEConnection {
  id: string;
  userId: string;
  actor: Actor;
  filter: SubscriptionFilter;
  buffer: SubscriptionEvent[];
  /** Push an event to the SSE stream. Returns false if connection is closed. */
  push: (event: SubscriptionEvent | null) => boolean;
  /** Close this connection */
  close: () => void;
  lastActivity: number;
  createdAt: number;
}

// ── Default configuration ────────────────────────────────────

const DEFAULT_CONFIG: Required<SubscriptionConfig> = {
  enabled: true,
  maxConnectionsPerUser: 3,
  heartbeatInterval: 30_000,
  idleTimeout: 300_000,
  maxBufferSize: 100,
  maxReplayBufferSize: 500,
};

// ── Event type mapping ───────────────────────────────────────

/** Map EventBus event types to SubscriptionEvent types */
function mapEventType(
  busEventType: string,
  payload: Record<string, unknown>,
): SubscriptionEvent["type"] | null {
  switch (busEventType) {
    case "record.created":
      return "record.created";
    case "record.updated":
      return "record.updated";
    case "record.deleted":
      return "record.deleted";
    case "state.transition":
      return "state.changed";
    case "approval.resolved":
      return "approval.resolved";
    default:
      // Check if payload has stateTransition for action.succeeded events
      if (busEventType === "action.succeeded" && payload.stateTransition) {
        return "state.changed";
      }
      return null;
  }
}

// ── SubscriptionManager ──────────────────────────────────────

export class SubscriptionManager {
  private connections = new Map<string, SSEConnection>();
  private config: Required<SubscriptionConfig>;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private idleCheckTimer: ReturnType<typeof setInterval> | null = null;
  private eventBusUnsubscribers: Array<() => void> = [];
  private eventIdCounter = 0;

  /** Ring buffer of recent events for Last-Event-ID replay on reconnection */
  private recentEvents: Array<{ id: string; event: SubscriptionEvent }> = [];

  /** Optional callback to check if an actor can read a given schema */
  private canReadEntity?: (actor: Actor, entityName: string) => boolean;

  constructor(
    private eventBus: EventBus,
    config?: SubscriptionConfig,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Set an optional permission checker. When set, events are only
   * forwarded to connections whose actor passes the check.
   */
  setPermissionChecker(checker: (actor: Actor, entityName: string) => boolean): void {
    this.canReadEntity = checker;
  }

  /** Start listening to EventBus and running heartbeat/idle timers */
  start(): void {
    this.wireEventBus();
    this.startHeartbeat();
    this.startIdleCheck();
  }

  /** Stop all timers and disconnect all clients */
  stop(): void {
    // Clear timers
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.idleCheckTimer) {
      clearInterval(this.idleCheckTimer);
      this.idleCheckTimer = null;
    }

    // Unsubscribe from EventBus
    for (const unsub of this.eventBusUnsubscribers) {
      unsub();
    }
    this.eventBusUnsubscribers = [];

    // Close all connections
    for (const conn of this.connections.values()) {
      conn.close();
    }
    this.connections.clear();

    // Clear replay buffer
    this.recentEvents = [];
  }

  /**
   * Register a new SSE connection.
   *
   * Returns connection ID or null if user has hit the connection limit.
   */
  addConnection(options: {
    userId: string;
    actor: Actor;
    filter: SubscriptionFilter;
    push: (event: SubscriptionEvent | null) => boolean;
    close: () => void;
  }): string | null {
    // Enforce per-user connection limit
    const userConnCount = this.countUserConnections(options.userId);
    if (userConnCount >= this.config.maxConnectionsPerUser) {
      return null;
    }

    const id = `sub_${crypto.randomUUID().slice(0, 12)}`;
    const now = Date.now();

    const conn: SSEConnection = {
      id,
      userId: options.userId,
      actor: options.actor,
      filter: options.filter,
      buffer: [],
      push: options.push,
      close: options.close,
      lastActivity: now,
      createdAt: now,
    };

    this.connections.set(id, conn);
    return id;
  }

  /** Remove a connection by ID */
  removeConnection(id: string): void {
    const conn = this.connections.get(id);
    if (conn) {
      conn.close();
      this.connections.delete(id);
    }
  }

  /** Get the number of active connections */
  get connectionCount(): number {
    return this.connections.size;
  }

  /** Get the number of connections for a specific user */
  countUserConnections(userId: string): number {
    let count = 0;
    for (const conn of this.connections.values()) {
      if (conn.userId === userId) count++;
    }
    return count;
  }

  // ── EventBus wiring ──────────────────────────────────────

  private wireEventBus(): void {
    const eventTypes = [
      "record.created",
      "record.updated",
      "record.deleted",
      "state.transition",
      "approval.resolved",
      "action.succeeded",
    ];

    for (const eventType of eventTypes) {
      const unsub = this.eventBus.subscribe(eventType, async (event: EventRecord) => {
        this.dispatchEvent(event);
      });
      this.eventBusUnsubscribers.push(unsub);
    }
  }

  /** Transform an EventRecord and dispatch to matching connections */
  private dispatchEvent(event: EventRecord): void {
    const entityName = event.entity;
    if (!entityName) return;

    const subEventType = mapEventType(event.type, event.payload);
    if (!subEventType) return;

    const recordId = event.recordId ?? (event.payload.id as string) ?? "";

    const subEvent: SubscriptionEvent = {
      type: subEventType,
      entity: entityName,
      recordId,
      tenantId: event.tenantId,
      actor: event.actor,
      timestamp: event.timestamp.toISOString(),
      executionId: event.executionId,
    };

    // Attach changes for create/update
    if (subEventType === "record.created" || subEventType === "record.updated") {
      // Filter out internal fields from changes
      const changes = { ...event.payload };
      delete changes.id;
      delete changes._version;
      if (Object.keys(changes).length > 0) {
        subEvent.changes = changes;
      }
    }

    // Attach state transition info
    if (subEventType === "state.changed") {
      const st = event.payload.stateTransition as { from: string; to: string } | undefined;
      if (st) {
        subEvent.state = {
          from: st.from,
          to: st.to,
          action: event.action ?? event.type,
        };
      }
    }

    // Assign event ID and store in replay buffer
    const eventId = this.nextEventId();
    this.storeInReplayBuffer(eventId, subEvent);

    // Dispatch to all matching connections
    for (const conn of this.connections.values()) {
      if (this.matchesConnection(conn, subEvent)) {
        this.pushToConnection(conn, subEvent, eventId);
      }
    }
  }

  /** Check if a subscription event matches a connection's filter */
  private matchesConnection(conn: SSEConnection, event: SubscriptionEvent): boolean {
    const filter = conn.filter;

    // Permission check — if a checker is set, verify the actor can read this schema
    if (this.canReadEntity && !this.canReadEntity(conn.actor, event.entity)) {
      return false;
    }

    // Tenant isolation — mandatory
    if (filter.tenantId && event.tenantId && filter.tenantId !== event.tenantId) {
      return false;
    }

    // Entity filter
    if (filter.entities.length > 0 && !filter.entities.includes(event.entity)) {
      return false;
    }

    // Record ID filter (fine-grained)
    if (filter.ids && filter.ids.length > 0 && !filter.ids.includes(event.recordId)) {
      return false;
    }

    return true;
  }

  /** Push an event to a connection, handling backpressure */
  private pushToConnection(conn: SSEConnection, event: SubscriptionEvent, eventId?: string): void {
    conn.lastActivity = Date.now();

    // Stamp event ID for SSE formatting if provided
    if (eventId) {
      event = { ...event, eventId };
    }

    // Backpressure: drop if buffer is full
    if (conn.buffer.length >= this.config.maxBufferSize) {
      // Drop oldest events
      conn.buffer.shift();
    }

    conn.buffer.push(event);

    // Try to deliver
    const ok = conn.push(event);
    if (ok) {
      // Delivered — clear from buffer
      const idx = conn.buffer.indexOf(event);
      if (idx >= 0) conn.buffer.splice(idx, 1);
    } else {
      // Connection dead — close and remove it
      conn.close();
      this.connections.delete(conn.id);
    }
  }

  // ── Replay buffer ───────────────────────────────────────

  /** Store an event in the ring buffer, evicting oldest when full */
  private storeInReplayBuffer(id: string, event: SubscriptionEvent): void {
    if (this.recentEvents.length >= this.config.maxReplayBufferSize) {
      this.recentEvents.shift();
    }
    this.recentEvents.push({ id, event });
  }

  /**
   * Replay buffered events to a connection starting after lastEventId.
   *
   * Only events that match the connection's filter are replayed.
   * Returns the number of events replayed.
   */
  replayFrom(lastEventId: string, connectionId: string): number {
    const conn = this.connections.get(connectionId);
    if (!conn) return 0;

    // Find the index of the last event the client received
    const lastIdx = this.recentEvents.findIndex((e) => e.id === lastEventId);
    if (lastIdx === -1) {
      // lastEventId not found in buffer — it may have been evicted.
      // Replay everything in the buffer that matches the connection's filter.
      let count = 0;
      for (const entry of this.recentEvents) {
        if (this.matchesConnection(conn, entry.event)) {
          this.pushToConnection(conn, entry.event, entry.id);
          count++;
        }
      }
      return count;
    }

    // Replay events after lastIdx
    let count = 0;
    const eventsToReplay = this.recentEvents.slice(lastIdx + 1);
    for (const entry of eventsToReplay) {
      if (this.matchesConnection(conn, entry.event)) {
        this.pushToConnection(conn, entry.event, entry.id);
        count++;
      }
    }
    return count;
  }

  /** Get the current replay buffer size (for testing/diagnostics) */
  get replayBufferSize(): number {
    return this.recentEvents.length;
  }

  // ── Heartbeat ─────────────────────────────────────────────

  private startHeartbeat(): void {
    if (this.config.heartbeatInterval <= 0) return;
    this.heartbeatTimer = setInterval(() => {
      for (const conn of this.connections.values()) {
        // Send heartbeat as null event (SSE comment)
        const ok = conn.push(null);
        if (!ok) {
          conn.close();
          this.connections.delete(conn.id);
        }
      }
    }, this.config.heartbeatInterval);
  }

  // ── Idle check ────────────────────────────────────────────

  private startIdleCheck(): void {
    if (this.config.idleTimeout <= 0) return;
    // Check every 60 seconds
    this.idleCheckTimer = setInterval(() => {
      const now = Date.now();
      for (const conn of this.connections.values()) {
        if (now - conn.lastActivity > this.config.idleTimeout) {
          conn.close();
          this.connections.delete(conn.id);
        }
      }
    }, 60_000);
  }

  /** Generate a monotonically increasing event ID for Last-Event-ID support */
  nextEventId(): string {
    return String(++this.eventIdCounter);
  }
}

// ── Helpers ──────────────────────────────────────────────────

/** Parse subscription query parameters from URL search params */
export function parseSubscriptionQuery(
  query: Record<string, string | undefined>,
): SubscriptionFilter {
  const entities = query.entities
    ? query.entities
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  const ids = query.ids
    ? query.ids
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

  return { entities, ids: ids && ids.length > 0 ? ids : undefined };
}

/**
 * Format a SubscriptionEvent as SSE text.
 *
 * Returns a string like:
 *   id: 42
 *   event: record.updated
 *   data: {"schema":"task",...}
 *
 * For heartbeat (null event), returns a comment line:
 *   : keepalive
 */
export function formatSSEEvent(event: SubscriptionEvent | null, eventId?: string): string {
  if (event === null) {
    return ": keepalive\n\n";
  }

  const lines: string[] = [];
  if (eventId) {
    lines.push(`id: ${eventId}`);
  }
  lines.push(`event: ${event.type}`);
  lines.push(`data: ${JSON.stringify(event)}`);
  lines.push(""); // trailing newline
  lines.push(""); // double newline terminates event
  return lines.join("\n");
}
