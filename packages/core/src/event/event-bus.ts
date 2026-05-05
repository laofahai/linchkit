/**
 * Event Bus / Event Engine
 *
 * In-memory event dispatch mechanism for M0b.
 * Manages event handler registration and event emission with
 * priority ordering, filtering, and sync/async execution modes.
 */

import { consoleLogger } from "../observability/console-logger";
import type { MetricsCollector } from "../observability/metrics";
import { noopMetricsCollector } from "../observability/metrics";
import { withTrace } from "../observability/trace-context";
import type { EventHandlerContext, EventHandlerDefinition, EventRecord } from "../types/event";
import { type ExecutionMeta, ExecutionMetaImpl } from "../types/execution-meta";
import type { Logger } from "../types/logger";

// ── Default priority ────────────────────────────────────────

const DEFAULT_PRIORITY = 100;
const DEFAULT_MAX_EMIT_DEPTH = 10;
const DEFAULT_MAX_EVENT_LOG_SIZE = 1000;

// ── EventHandlerRegistry ────────────────────────────────────

export class EventHandlerRegistry {
  private handlers = new Map<string, EventHandlerDefinition>();

  /** Register an event handler. Throws if name is already registered. */
  register(handler: EventHandlerDefinition): void {
    if (!handler.name) {
      throw new Error("EventHandler must have a name");
    }
    if (this.handlers.has(handler.name)) {
      throw new Error(`EventHandler "${handler.name}" is already registered`);
    }
    this.handlers.set(handler.name, handler);
  }

  /** Get a handler by name */
  get(name: string): EventHandlerDefinition | undefined {
    return this.handlers.get(name);
  }

  /** Get all registered handlers */
  getAll(): EventHandlerDefinition[] {
    return Array.from(this.handlers.values());
  }

  /** Get all handlers that listen to a specific event type */
  getByEvent(eventType: string): EventHandlerDefinition[] {
    return this.getAll().filter((h) => {
      const listen = Array.isArray(h.listen) ? h.listen : [h.listen];
      return listen.includes(eventType);
    });
  }
}

// ── Filter matching ─────────────────────────────────────────

/**
 * Simple field matching: every key in the filter must match the
 * corresponding field in the event payload.
 */
export function matchesFilter(
  payload: Record<string, unknown>,
  filter: Record<string, unknown>,
): boolean {
  for (const [key, value] of Object.entries(filter)) {
    if (payload[key] !== value) {
      return false;
    }
  }
  return true;
}

// ── EventBus ────────────────────────────────────────────────

export interface EventBusOptions {
  registry: EventHandlerRegistry;
  maxEmitDepth?: number;
  logger?: Logger;
  maxEventLogSize?: number;
  metrics?: MetricsCollector;
}

export class EventBus {
  protected registry: EventHandlerRegistry;
  protected eventLog: EventRecord[] = [];
  protected emitDepth = 0;
  protected maxEmitDepth: number;
  protected maxEventLogSize: number;
  protected logger: Logger;
  protected metrics: MetricsCollector;

  constructor(opts: EventBusOptions);
  /** @deprecated Use options object instead */
  constructor(
    registry: EventHandlerRegistry,
    maxEmitDepth?: number,
    logger?: Logger,
    maxEventLogSize?: number,
    metrics?: MetricsCollector,
  );
  constructor(
    registryOrOpts: EventHandlerRegistry | EventBusOptions,
    maxEmitDepth = DEFAULT_MAX_EMIT_DEPTH,
    logger: Logger = consoleLogger,
    maxEventLogSize = DEFAULT_MAX_EVENT_LOG_SIZE,
    metrics: MetricsCollector = noopMetricsCollector,
  ) {
    if ("registry" in registryOrOpts && !(registryOrOpts instanceof EventHandlerRegistry)) {
      const opts = registryOrOpts;
      this.registry = opts.registry;
      this.maxEmitDepth = opts.maxEmitDepth ?? DEFAULT_MAX_EMIT_DEPTH;
      this.maxEventLogSize = opts.maxEventLogSize ?? DEFAULT_MAX_EVENT_LOG_SIZE;
      this.logger = opts.logger ?? consoleLogger;
      this.metrics = opts.metrics ?? noopMetricsCollector;
    } else {
      this.registry = registryOrOpts as EventHandlerRegistry;
      this.maxEmitDepth = maxEmitDepth;
      this.maxEventLogSize = maxEventLogSize;
      this.logger = logger;
      this.metrics = metrics;
    }
  }

  /**
   * Dispatch an event to all matching handlers.
   *
   * - Matches handlers whose `listen` field includes the event type
   * - Applies handler.filter if present (simple payload field matching)
   * - Sorts by priority (lower = higher priority, default 100)
   * - Sync handlers execute in sequence; errors stop the chain
   * - Async handlers are fire-and-forget (errors logged but not thrown)
   * - Recursion is guarded by maxEmitDepth (default 10)
   */
  async emit(event: EventRecord): Promise<void> {
    // Guard against infinite recursion
    if (this.emitDepth >= this.maxEmitDepth) {
      throw new Error(
        `EventBus max emit depth (${this.maxEmitDepth}) exceeded for event "${event.type}". Possible infinite loop.`,
      );
    }

    this.emitDepth++;
    try {
      // Record the event, trimming old entries to prevent unbounded growth
      this.eventLog.push(event);
      if (this.eventLog.length > this.maxEventLogSize) {
        this.eventLog = this.eventLog.slice(-this.maxEventLogSize);
      }

      this.metrics.increment("event.emitted", { eventType: event.type });

      // Find matching handlers
      const handlers = this.registry.getByEvent(event.type);

      // Apply filters
      const matched = handlers.filter((h) => {
        if (!h.filter) return true;
        return matchesFilter(event.payload, h.filter);
      });

      // Sort by priority (lower number = higher priority)
      matched.sort((a, b) => (a.priority ?? DEFAULT_PRIORITY) - (b.priority ?? DEFAULT_PRIORITY));

      // Build handler context, propagating tenant scope to chained events
      // and the originating action's ExecutionMeta (Spec 65 §7).
      const ctx = this.createHandlerContext(event.tenantId, event.meta);

      // Execute handlers
      for (const handler of matched) {
        // Shallow copy event record so handlers cannot mutate shared state
        const eventCopy = { ...event, payload: { ...event.payload } };

        if (handler.async) {
          // Fire-and-forget: don't await, log errors
          (withTrace(() => handler.handler(eventCopy, ctx)) as Promise<void>).catch((err) => {
            this.logger.warn(
              `[EventBus] Async handler "${handler.name}" failed for event "${event.type}": ${err}`,
            );
          });
        } else {
          // Sync: execute in sequence, propagate errors
          await withTrace(() => handler.handler(eventCopy, ctx));
        }
      }
    } finally {
      this.emitDepth--;
    }
  }

  /** Return all emitted events (in-memory log) */
  getEmittedEvents(): EventRecord[] {
    return [...this.eventLog];
  }

  /** Clear the event log */
  clear(): void {
    this.eventLog = [];
  }

  /**
   * Subscribe to a specific event type with a callback.
   * Returns an unsubscribe function. Used by TriggerBinding.
   */
  subscribe(
    eventType: string,
    handler: (event: EventRecord) => void | Promise<void>,
    options?: { sync?: boolean },
  ): () => void {
    const name = `__sub_${eventType}_${crypto.randomUUID().slice(0, 8)}`;
    const handlerDef: EventHandlerDefinition = {
      name,
      listen: eventType,
      async: !options?.sync,
      handler: async (event) => {
        await handler(event);
      },
    };
    this.registry.register(handlerDef);
    return () => {
      // Remove from registry by deleting from internal map
      // biome-ignore lint/suspicious/noExplicitAny: accessing private Map for unsubscribe
      (this.registry as any).handlers.delete(name);
    };
  }

  /** Create a minimal EventHandlerContext for handler execution.
   *  Accepts optional tenantId to propagate tenant scope to chained events
   *  and optional ExecutionMeta from the originating action (Spec 65 §7).
   *  When no meta is supplied (system-emitted events), an empty
   *  ExecutionMeta is constructed so `ctx.meta.get(...)` returns `undefined`
   *  instead of throwing. */
  protected createHandlerContext(tenantId?: string, meta?: ExecutionMeta): EventHandlerContext {
    const handlerMeta: ExecutionMeta = meta ?? new ExecutionMetaImpl({});
    return {
      emit: (eventType: string, payload: Record<string, unknown>) => {
        const record: EventRecord = {
          id: crypto.randomUUID(),
          type: eventType,
          category: "custom",
          timestamp: new Date(),
          actor: { type: "system", id: "event-bus" },
          executionId: crypto.randomUUID(),
          payload,
          tenantId,
          // Propagate the parent handler's meta to chained events so the next
          // handler in the chain still sees the originating action's caller hints.
          meta: handlerMeta,
        };
        // Fire-and-forget re-emission
        this.emit(record).catch(() => {
          // Intentionally swallowed
        });
      },
      meta: handlerMeta,
    };
  }
}

// ── Factory ─────────────────────────────────────────────────

/** Create a new EventBus with its own EventHandlerRegistry */
export function createEventBus(options?: { metrics?: MetricsCollector }): {
  registry: EventHandlerRegistry;
  bus: EventBus;
} {
  const registry = new EventHandlerRegistry();
  const bus = new EventBus(
    registry,
    DEFAULT_MAX_EMIT_DEPTH,
    consoleLogger,
    DEFAULT_MAX_EVENT_LOG_SIZE,
    options?.metrics,
  );
  return { registry, bus };
}
