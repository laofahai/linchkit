/**
 * EventBusReplayService — in-memory event replay over the EventBus log
 * (Spec 66 §4.1–4.3).
 *
 * In-memory replay over the EventBus log — distinct from the DB-backed
 * `EventReplayService` in `event-replay-service.ts`, which serves the
 * production audit-trail replay use case (CLI, GraphQL, audit-ui).
 *
 * Supports replaying events from the EventBus in-memory log by ID or by
 * execution ID. Two modes: dry-run (default) simulates dispatch and reports
 * which handlers would fire; live re-emits events with replay metadata so
 * handlers can detect and conditionally skip non-idempotent side effects.
 */

import type { EventRecord } from "../types/event";
import { createExecutionMeta, extendExecutionMeta } from "../types/execution-meta";
import { type EventBus, type EventHandlerRegistry, matchesFilter } from "./event-bus";

// ── Spec 66 §4.3 hard limit per invocation ──────────────────

const MAX_EVENTS_PER_REPLAY = 10_000;
const DEFAULT_PRIORITY = 100;

// ── Public types ─────────────────────────────────────────────

/** Replay context injected into replayed events via ExecutionMeta (Spec 66 §4.3) */
export interface EventBusReplayMeta {
  originEventId: string;
  replayId: string;
  dryRun: boolean;
}

export interface EventBusReplayOptions {
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

export interface EventBusReplayedHandlerInfo {
  handlerName: string;
}

/**
 * Error captured during a single handler dispatch (live mode) or
 * an emit-level failure that affected the whole event.
 * `handlerName` is `"<emit>"` when the error came from the EventBus
 * itself (e.g., dedup-window race, recursion guard) rather than a
 * specific handler.
 */
export interface EventBusReplayedHandlerError {
  handlerName: string;
  message: string;
}

export interface EventBusReplayedEventResult {
  originEventId: string;
  /** ID of the newly emitted event. Set only in live mode. */
  replayEventId?: string;
  eventType: string;
  handlers: EventBusReplayedHandlerInfo[];
  status: "replayed" | "skipped";
  /** Why the event was skipped */
  skipReason?: "not_found" | "emit_error";
  /**
   * Errors captured during dispatch. Always present (may be empty) on live-mode
   * results so callers don't need null checks. Dry-run results never accumulate
   * errors because handlers are not invoked.
   *
   * Spec 66 §4 prohibits silently swallowing handler errors — every emit
   * failure surfaces here so the caller can decide how to react.
   */
  errors?: EventBusReplayedHandlerError[];
}

export interface EventBusReplayResult {
  /** Identifies this replay operation; matches `EventBusReplayMeta.replayId` on live events */
  replayId: string;
  dryRun: boolean;
  replayed: number;
  skipped: number;
  events: EventBusReplayedEventResult[];
  /** True when the execution's event count exceeded the 10k guard and results were truncated */
  truncated?: boolean;
  /**
   * Total events available for this execution before truncation. Equal to
   * `events.length` when `truncated` is false/absent; greater when truncated.
   * Lets callers report "N of M events replayed" without re-querying the log.
   */
  totalAvailable?: number;
}

export interface EventBusReplayService {
  /**
   * Replay a single event from the in-memory log by its ID.
   * Dry-run by default — pass `{ dryRun: false }` for live dispatch.
   */
  replayById(eventId: string, options?: EventBusReplayOptions): Promise<EventBusReplayResult>;

  /**
   * Replay all events belonging to an execution from the in-memory log.
   * Capped at 10,000 events per invocation (Spec 66 §4.3 guard).
   */
  replayByExecution(
    executionId: string,
    options?: EventBusReplayOptions,
  ): Promise<EventBusReplayResult>;
}

// ── Implementation ───────────────────────────────────────────

function getMatchedHandlerInfos(
  event: EventRecord,
  registry: EventHandlerRegistry,
): EventBusReplayedHandlerInfo[] {
  return registry
    .getByEvent(event.type)
    .filter((h) => !h.filter || matchesFilter(event.payload as Record<string, unknown>, h.filter))
    .sort((a, b) => (a.priority ?? DEFAULT_PRIORITY) - (b.priority ?? DEFAULT_PRIORITY))
    .map((h) => ({ handlerName: h.name }));
}

async function dispatchReplayBatch(
  events: EventRecord[],
  bus: EventBus,
  registry: EventHandlerRegistry,
  options: EventBusReplayOptions,
  replayId: string,
): Promise<EventBusReplayedEventResult[]> {
  const dryRun = options.dryRun ?? true;
  const results: EventBusReplayedEventResult[] = [];

  for (const event of events) {
    const handlerInfos = getMatchedHandlerInfos(event, registry);

    if (dryRun) {
      results.push({
        originEventId: event.id,
        eventType: event.type,
        handlers: handlerInfos,
        status: "replayed",
        errors: [],
      });
    } else {
      const replayMeta: EventBusReplayMeta = {
        originEventId: event.id,
        replayId,
        dryRun: false,
      };

      const baseMeta = event.meta ?? createExecutionMeta();
      // systemOverrides ensures replay key is always set even if base meta has it
      const newMeta = extendExecutionMeta(baseMeta, {}, { replay: replayMeta });

      // force:true assigns a unique key so dedup never suppresses the replay.
      // Important: EventBus derives a key from `${executionId}:${type}` when
      // `idempotencyKey` is absent, so simply preserving the original event's
      // missing key would still collide with the original on the dedup window.
      // We therefore unconditionally set a unique replay-scoped key when
      // force:true. When force:false we preserve the original key (or absence
      // thereof) and let the dedup window decide.
      const replayedEvent: EventRecord = {
        ...event,
        id: crypto.randomUUID(),
        timestamp: new Date(),
        idempotencyKey: options.force ? `replay:${replayId}:${event.id}` : event.idempotencyKey,
        meta: newMeta,
      };

      // Per Spec 66 §4: handler errors must never silently bubble out of replay.
      // Each emit is wrapped so a thrown sync handler doesn't abort the batch.
      try {
        await bus.emit(replayedEvent);
        results.push({
          originEventId: event.id,
          replayEventId: replayedEvent.id,
          eventType: event.type,
          handlers: handlerInfos,
          status: "replayed",
          errors: [],
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({
          originEventId: event.id,
          eventType: event.type,
          handlers: handlerInfos,
          status: "skipped",
          skipReason: "emit_error",
          errors: [{ handlerName: "<emit>", message }],
        });
      }
    }
  }

  return results;
}

export function createEventBusReplayService(
  bus: EventBus,
  registry: EventHandlerRegistry,
): EventBusReplayService {
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
              errors: [],
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
        return { replayId, dryRun, replayed: 0, skipped: 0, events: [], totalAvailable: 0 };
      }

      // Spec 66 §4.3 guard: cap at MAX_EVENTS_PER_REPLAY.
      // When truncation kicks in, surface `truncated: true` and `totalAvailable`
      // so callers can warn operators that the batch is incomplete.
      const totalAvailable = matching.length;
      const truncated = totalAvailable > MAX_EVENTS_PER_REPLAY;
      const capped = truncated ? matching.slice(0, MAX_EVENTS_PER_REPLAY) : matching;

      const eventResults = await dispatchReplayBatch(capped, bus, registry, options, replayId);
      return {
        replayId,
        dryRun,
        replayed: eventResults.filter((e) => e.status === "replayed").length,
        skipped: eventResults.filter((e) => e.status === "skipped").length,
        events: eventResults,
        totalAvailable,
        ...(truncated ? { truncated } : {}),
      };
    },
  };
}
