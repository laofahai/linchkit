/**
 * EventReplayService — in-memory event replay (Spec 66 §4.1–4.3)
 *
 * Supports replaying events from the EventBus in-memory log by ID or by
 * execution ID. Two modes: dry-run (default) simulates dispatch and reports
 * which handlers would fire; live re-emits events with replay metadata so
 * handlers can detect and conditionally skip non-idempotent side effects.
 */

import type { EventRecord } from "../types/event";
import { createExecutionMeta, extendExecutionMeta } from "../types/execution-meta";
import type { EventBus, EventHandlerRegistry } from "./event-bus";

// ── Spec 66 §4.3 hard limit per invocation ──────────────────

const MAX_EVENTS_PER_REPLAY = 10_000;

// ── Public types ─────────────────────────────────────────────

/** Replay context injected into replayed events via ExecutionMeta (Spec 66 §4.3) */
export interface ReplayMeta {
  originEventId: string;
  replayId: string;
  dryRun: boolean;
}

export interface ReplayOptions {
  /**
   * When true (default), simulates dispatch and reports which handlers would
   * fire without invoking them. No side effects, no database writes.
   */
  dryRun?: boolean;
  /**
   * When true, bypasses the EventBus dedup window so the event is dispatched
   * even if its idempotency key was recently seen. Useful for bug-fix replays.
   * Default: false.
   */
  force?: boolean;
}

export interface ReplayedHandlerInfo {
  handlerName: string;
}

export interface ReplayedEventResult {
  originEventId: string;
  /** ID of the newly emitted event. Set only in live mode. */
  replayEventId?: string;
  eventType: string;
  handlers: ReplayedHandlerInfo[];
  status: "replayed" | "skipped";
  /** Why the event was skipped */
  skipReason?: "not_found";
}

export interface ReplayResult {
  /** Identifies this replay operation; matches `ReplayMeta.replayId` on live events */
  replayId: string;
  dryRun: boolean;
  replayed: number;
  skipped: number;
  events: ReplayedEventResult[];
}

export interface EventReplayService {
  /**
   * Replay a single event from the in-memory log by its ID.
   * Dry-run by default — pass `{ dryRun: false }` for live dispatch.
   */
  replayById(eventId: string, options?: ReplayOptions): Promise<ReplayResult>;

  /**
   * Replay all events belonging to an execution from the in-memory log.
   * Capped at 10,000 events per invocation (Spec 66 §4.3 guard).
   */
  replayByExecution(executionId: string, options?: ReplayOptions): Promise<ReplayResult>;
}

// ── Implementation ───────────────────────────────────────────

async function dispatchReplayBatch(
  events: EventRecord[],
  bus: EventBus,
  registry: EventHandlerRegistry,
  options: ReplayOptions,
  replayId: string,
): Promise<ReplayedEventResult[]> {
  const dryRun = options.dryRun ?? true;
  const results: ReplayedEventResult[] = [];

  for (const event of events) {
    const handlers = registry.getByEvent(event.type);
    const handlerInfos: ReplayedHandlerInfo[] = handlers.map((h) => ({ handlerName: h.name }));

    if (dryRun) {
      results.push({
        originEventId: event.id,
        eventType: event.type,
        handlers: handlerInfos,
        status: "replayed",
      });
    } else {
      const replayMeta: ReplayMeta = {
        originEventId: event.id,
        replayId,
        dryRun: false,
      };

      const baseMeta = event.meta ?? createExecutionMeta();
      // systemOverrides ensures replay key is always set even if base meta has it
      const newMeta = extendExecutionMeta(baseMeta, {}, { replay: replayMeta });

      const replayedEvent: EventRecord = {
        ...event,
        id: crypto.randomUUID(),
        timestamp: new Date(),
        // Clear idempotency key so the replayed event is not suppressed by dedup
        // unless force:false and the bus dedup window would catch it via executionId
        idempotencyKey: options.force ? undefined : event.idempotencyKey,
        meta: newMeta,
      };

      await bus.emit(replayedEvent);

      results.push({
        originEventId: event.id,
        replayEventId: replayedEvent.id,
        eventType: event.type,
        handlers: handlerInfos,
        status: "replayed",
      });
    }
  }

  return results;
}

export function createEventReplayService(
  bus: EventBus,
  registry: EventHandlerRegistry,
): EventReplayService {
  return {
    async replayById(eventId, options = {}) {
      const replayId = crypto.randomUUID();
      const dryRun = options.dryRun ?? true;

      const log = bus.getEmittedEvents();
      const event = log.find((e) => e.id === eventId);

      if (!event) {
        return {
          replayId,
          dryRun,
          replayed: 0,
          skipped: 1,
          events: [
            {
              originEventId: eventId,
              eventType: "unknown",
              handlers: [],
              status: "skipped",
              skipReason: "not_found",
            },
          ],
        };
      }

      const eventResults = await dispatchReplayBatch([event], bus, registry, options, replayId);
      return {
        replayId,
        dryRun,
        replayed: eventResults.filter((e) => e.status === "replayed").length,
        skipped: eventResults.filter((e) => e.status === "skipped").length,
        events: eventResults,
      };
    },

    async replayByExecution(executionId, options = {}) {
      const replayId = crypto.randomUUID();
      const dryRun = options.dryRun ?? true;

      const log = bus.getEmittedEvents();
      const matching = log.filter((e) => e.executionId === executionId);

      if (matching.length === 0) {
        return { replayId, dryRun, replayed: 0, skipped: 0, events: [] };
      }

      // Spec 66 §4.3 guard: cap at MAX_EVENTS_PER_REPLAY
      const capped = matching.slice(0, MAX_EVENTS_PER_REPLAY);

      const eventResults = await dispatchReplayBatch(capped, bus, registry, options, replayId);
      return {
        replayId,
        dryRun,
        replayed: eventResults.filter((e) => e.status === "replayed").length,
        skipped: eventResults.filter((e) => e.status === "skipped").length,
        events: eventResults,
      };
    },
  };
}
