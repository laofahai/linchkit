/**
 * Events API client.
 *
 * Typed wrapper around the GraphQL surface that fronts
 * `eventReplayService` from `@linchkit/core` (see
 * `packages/core/src/event/event-replay-service.ts`):
 *
 *   - `list(options)`         → `eventList(...)` query
 *   - `replayEvent(id, opts)` → `eventReplay(id: ID!, dryRun, onlyHandler)` mutation
 *   - `getHandlerHistory(id)` → `eventHandlerHistory(eventId: ID!)` query
 *
 * The shapes mirror the service's public types
 * (`EventSummary`, `HandlerExecution`, `ReplayResult`) so the UI never
 * has to translate between snake_case wire fields and the typed core
 * surface — the GraphQL projection is expected to follow the camelCase
 * shape of the core service.
 *
 * If the server hasn't registered the eventList/eventReplay schema yet
 * the helpers surface the GraphQL error as a thrown `Error` so the UI
 * can show a "service unavailable" state rather than silently rendering
 * an empty timeline.
 */

import { graphql } from "@linchkit/cap-adapter-ui/lib/api";

// ── Public types — mirror @linchkit/core/event ───────────

export type EventStatus = "pending" | "processing" | "completed" | "failed" | "dead_letter";

export interface EventSummary {
  id: string;
  tenantId?: string;
  eventType: string;
  status: EventStatus;
  /** Action that emitted the event. Used as the "entity" filter alias. */
  sourceAction?: string;
  sourceExecutionId?: string;
  retryCount: number;
  errorMessage?: string;
  /** ISO timestamp. */
  createdAt: string;
  /** ISO timestamp. */
  processedAt?: string;
}

export interface EventListResult {
  events: EventSummary[];
  total: number;
}

export interface EventListOptions {
  /** Filter by sourceAction. */
  entity?: string;
  /** Filter by sourceExecutionId. Server-side filter only — clients that
   *  do not know the originating execution id can simply omit this. */
  recordId?: string;
  /** ISO timestamp lower bound (inclusive). */
  since?: string;
  /** ISO timestamp upper bound (inclusive). */
  until?: string;
  /** Max entries to return (server clamps to <=100, default 50). */
  limit?: number;
  /** Number of entries to skip (default 0). */
  offset?: number;
}

export interface HandlerHistoryEntry {
  handler: string;
  status: EventStatus;
  /** Total runtime in ms; null/undefined when the run never completed. */
  durationMs?: number;
  error?: string;
}

export interface ReplayHandlerOutcome {
  handler: string;
  /** `"success"` when delivered without throwing; `"error"` otherwise. */
  status: "success" | "error";
  error?: string;
}

export interface ReplayReport {
  eventId: string;
  /** True when the replay was a dry run — no handlers were invoked. */
  dryRun: boolean;
  delivered: number;
  failed: number;
  handlers: ReplayHandlerOutcome[];
}

export interface ReplayEventOptions {
  /** When true, the server validates the replay path without invoking handlers. */
  dryRun?: boolean;
  /** Comma-separated handler names to restrict the replay to (single handler also accepted). */
  handlers?: string;
}

// ── GraphQL queries ──────────────────────────────────────

const LIST_QUERY = `
  query EventList(
    $entity: String
    $recordId: String
    $since: String
    $until: String
    $limit: Int
    $offset: Int
  ) {
    eventList(
      entity: $entity
      recordId: $recordId
      since: $since
      until: $until
      limit: $limit
      offset: $offset
    ) {
      events {
        id tenantId eventType status
        sourceAction sourceExecutionId
        retryCount errorMessage
        createdAt processedAt
      }
      total
    }
  }
`;

const HISTORY_QUERY = `
  query EventHandlerHistory($eventId: ID!) {
    eventHandlerHistory(eventId: $eventId) {
      handler status durationMs error
    }
  }
`;

const REPLAY_MUTATION = `
  mutation EventReplay($eventId: ID!, $dryRun: Boolean, $handlers: String) {
    eventReplay(eventId: $eventId, dryRun: $dryRun, handlers: $handlers) {
      eventId dryRun delivered failed
      handlers { handler status error }
    }
  }
`;

// ── Helpers ──────────────────────────────────────────────

function throwFirstError(errors: { message: string }[] | undefined, fallback: string): never {
  const first = errors?.at(0);
  throw new Error(first?.message ?? fallback);
}

// ── List ─────────────────────────────────────────────────

/**
 * Fetch a page of persisted events for the timeline view.
 *
 * Defaults: limit 50, offset 0; the server orders newest-first by
 * `createdAt`. Pass `since`/`until` as ISO strings to constrain to a
 * window — the server applies them as inclusive bounds.
 */
export async function list(options: EventListOptions = {}): Promise<EventListResult> {
  const res = await graphql<{ eventList: EventListResult }>(LIST_QUERY, {
    entity: options.entity,
    recordId: options.recordId,
    since: options.since,
    until: options.until,
    limit: options.limit,
    offset: options.offset,
  });

  if (res.errors && res.errors.length > 0) {
    throwFirstError(res.errors, "Failed to query event list");
  }

  return res.data?.eventList ?? { events: [], total: 0 };
}

// ── Replay ───────────────────────────────────────────────

/**
 * Re-dispatch a persisted event through its registered handlers.
 *
 * The server invokes `eventReplayService.replay(eventId, { onlyHandler })`
 * under the hood and projects the `ReplayResult` into the
 * camelCase `ReplayReport` shape used by the UI. With `dryRun: true`
 * the server resolves the candidate handlers without actually invoking
 * them so an operator can confirm the impact before triggering side
 * effects.
 */
export async function replayEvent(
  eventId: string,
  options: ReplayEventOptions = {},
): Promise<ReplayReport> {
  const res = await graphql<{ eventReplay: ReplayReport }>(REPLAY_MUTATION, {
    eventId,
    dryRun: options.dryRun ?? false,
    handlers: options.handlers,
  });

  if (res.errors && res.errors.length > 0) {
    throwFirstError(res.errors, "Failed to replay event");
  }

  const report = res.data?.eventReplay;
  if (!report) throw new Error("Replay returned no data");
  return report;
}

// ── Handler history ──────────────────────────────────────

/**
 * Fetch the per-handler delivery history for a single event.
 *
 * Until the server has per-handler completion tracking (Spec 66 §2.4)
 * this query returns a single wildcard entry whose `handler` is `"*"`.
 * Surface that as-is — the panel renders it as an "aggregate" row.
 */
export async function getHandlerHistory(eventId: string): Promise<HandlerHistoryEntry[]> {
  const res = await graphql<{ eventHandlerHistory: HandlerHistoryEntry[] }>(HISTORY_QUERY, {
    eventId,
  });

  if (res.errors && res.errors.length > 0) {
    throwFirstError(res.errors, "Failed to query handler history");
  }

  return res.data?.eventHandlerHistory ?? [];
}
