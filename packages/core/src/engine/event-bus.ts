/**
 * Event Bus / Event Engine
 *
 * In-memory event dispatch mechanism for M0b.
 * Manages event handler registration and event emission with
 * priority ordering, filtering, and sync/async execution modes.
 */

import type { EventHandlerContext, EventHandlerDefinition, EventRecord } from "../types/event";
import type { Logger } from "../types/logger";
import { consoleLogger } from "./console-logger";

// ── Default priority ────────────────────────────────────────

const DEFAULT_PRIORITY = 100;
const DEFAULT_MAX_EMIT_DEPTH = 10;

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
function matchesFilter(payload: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(filter)) {
    if (payload[key] !== value) {
      return false;
    }
  }
  return true;
}

// ── EventBus ────────────────────────────────────────────────

export class EventBus {
  private registry: EventHandlerRegistry;
  private eventLog: EventRecord[] = [];
  private emitDepth = 0;
  private maxEmitDepth: number;
  private logger: Logger;

  constructor(registry: EventHandlerRegistry, maxEmitDepth = DEFAULT_MAX_EMIT_DEPTH, logger: Logger = consoleLogger) {
    this.registry = registry;
    this.maxEmitDepth = maxEmitDepth;
    this.logger = logger;
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
      // Record the event
      this.eventLog.push(event);

      // Find matching handlers
      const handlers = this.registry.getByEvent(event.type);

      // Apply filters
      const matched = handlers.filter((h) => {
        if (!h.filter) return true;
        return matchesFilter(event.payload, h.filter);
      });

      // Sort by priority (lower number = higher priority)
      matched.sort((a, b) => (a.priority ?? DEFAULT_PRIORITY) - (b.priority ?? DEFAULT_PRIORITY));

      // Build handler context
      const ctx = this.createHandlerContext();

      // Execute handlers
      for (const handler of matched) {
        // Shallow copy event record so handlers cannot mutate shared state
        const eventCopy = { ...event, payload: { ...event.payload } };

        if (handler.async) {
          // Fire-and-forget: don't await, log errors
          handler.handler(eventCopy, ctx).catch((err) => {
            this.logger.warn(
              `[EventBus] Async handler "${handler.name}" failed for event "${event.type}": ${err}`,
            );
          });
        } else {
          // Sync: execute in sequence, propagate errors
          await handler.handler(eventCopy, ctx);
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

  /** Create a minimal EventHandlerContext for handler execution */
  private createHandlerContext(): EventHandlerContext {
    return {
      execute: () => {
        throw new Error("execute() is not wired");
      },
      emit: (eventType: string, payload: Record<string, unknown>) => {
        const record: EventRecord = {
          id: crypto.randomUUID(),
          type: eventType,
          category: "custom",
          timestamp: new Date(),
          actor: { type: "system", id: "event-bus" },
          executionId: crypto.randomUUID(),
          payload,
        };
        // Fire-and-forget re-emission
        this.emit(record).catch(() => {
          // Intentionally swallowed
        });
      },
      get: () => {
        throw new Error("get() is not wired");
      },
      query: () => {
        throw new Error("query() is not wired");
      },
    };
  }
}

// ── Factory ─────────────────────────────────────────────────

/** Create a new EventBus with its own EventHandlerRegistry */
export function createEventBus(): {
  registry: EventHandlerRegistry;
  bus: EventBus;
} {
  const registry = new EventHandlerRegistry();
  const bus = new EventBus(registry);
  return { registry, bus };
}
