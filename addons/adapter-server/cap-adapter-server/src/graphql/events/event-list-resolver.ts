/**
 * `eventList` GraphQL query — paginated event timeline.
 *
 * Fronts `EventReplayService.list(...)`. The service already supports
 * `entity`/`since`/`until`/`limit`/`offset`/`tenantId` filtering — the
 * resolver forwards the request context's tenant so cross-tenant leakage
 * is impossible.
 *
 * `recordId` filter:
 *   The UI passes `recordId` but `EventReplayService.list` does not yet
 *   accept it. We drop the argument silently (NOT error) so a UI bug
 *   does not break the list — see the `TODO(recordId)` below.
 */

import type { EventReplayService, EventSummary } from "@linchkit/core";
import {
  GraphQLError,
  type GraphQLFieldConfig,
  GraphQLInt,
  GraphQLNonNull,
  GraphQLString,
} from "graphql";
import { EventListResultType } from "./event-types";
import { parseIsoDate, requireAdmin } from "./shared";

interface EventListResolverContext {
  actor?: { id?: string; type?: string; groups?: string[] };
  tenantId?: string;
}

interface EventListArgs {
  entity?: string;
  // TODO(recordId): drop once EventReplayService.list supports recordId/sourceExecutionId filtering.
  recordId?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

/**
 * Project a `core` `EventSummary` (`createdAt: Date`) onto the wire-format
 * shape expected by the UI (`createdAt: string`, ISO 8601).
 */
function projectSummary(item: EventSummary): {
  id: string;
  tenantId: string | null;
  eventType: string;
  status: string;
  sourceAction: string | null;
  sourceExecutionId: string | null;
  retryCount: number;
  errorMessage: string | null;
  createdAt: string;
  processedAt: string | null;
} {
  return {
    id: item.id,
    tenantId: item.tenantId ?? null,
    eventType: item.eventType,
    status: item.status,
    sourceAction: item.sourceAction ?? null,
    sourceExecutionId: item.sourceExecutionId ?? null,
    retryCount: item.retryCount,
    errorMessage: item.errorMessage ?? null,
    createdAt: item.createdAt.toISOString(),
    processedAt: item.processedAt ? item.processedAt.toISOString() : null,
  };
}

/** Build the `eventList` query field bound to a specific service instance. */
export function buildEventListField(
  service: EventReplayService,
): GraphQLFieldConfig<unknown, unknown> {
  return {
    type: new GraphQLNonNull(EventListResultType),
    description:
      "Paginated event timeline. Tenant-scoped via the request context; admin-only. " +
      "Forwarded to EventReplayService.list — see @linchkit/core/event.",
    args: {
      entity: {
        type: GraphQLString,
        description: "Filter by sourceAction (the action that emitted the event).",
      },
      recordId: {
        type: GraphQLString,
        description:
          "Reserved for future use — accepted for UI forward-compatibility but ignored " +
          "until EventReplayService supports recordId/sourceExecutionId filtering.",
      },
      since: { type: GraphQLString, description: "ISO 8601 timestamp lower bound (inclusive)." },
      until: { type: GraphQLString, description: "ISO 8601 timestamp upper bound (inclusive)." },
      limit: {
        type: GraphQLInt,
        description: "Max entries to return (server clamps to <=100, default 50).",
      },
      offset: { type: GraphQLInt, description: "Number of entries to skip (default 0)." },
    },
    resolve: async (
      _root: unknown,
      args: EventListArgs,
      contextValue: unknown,
    ): Promise<{
      events: ReturnType<typeof projectSummary>[];
      total: number;
    }> => {
      const ctx = (contextValue ?? {}) as EventListResolverContext;
      requireAdmin(ctx.actor);

      let since: Date | undefined;
      let until: Date | undefined;
      try {
        since = parseIsoDate(args.since);
        until = parseIsoDate(args.until);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Invalid ISO date";
        throw new GraphQLError(message);
      }

      const result = await service.list({
        tenantId: ctx.tenantId,
        entity: args.entity,
        since,
        until,
        limit: args.limit,
        offset: args.offset,
      });

      return {
        events: result.items.map(projectSummary),
        total: result.total,
      };
    },
  };
}
