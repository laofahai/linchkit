/**
 * `eventHandlerHistory(eventId: ID!)` GraphQL query — per-event handler
 * delivery summary.
 *
 * Fronts `EventReplayService.handlerHistory({ eventId })`. The service
 * currently emits a single wildcard entry whose `handler` is `"*"` until
 * per-handler tracking lands (Spec 66 §2.4) — surface the entry as-is.
 *
 * Tenant scoping: the service `handlerHistory` query does not filter by
 * tenant, so the resolver loads the event via `get(id)` and rejects access
 * when the row belongs to a different tenant.
 */

import type { EventReplayService, HandlerExecution } from "@linchkit/core";
import {
  GraphQLError,
  type GraphQLFieldConfig,
  GraphQLID,
  GraphQLList,
  GraphQLNonNull,
} from "graphql";
import { HandlerHistoryEntryType } from "./event-types";
import { isVisibleToTenant, requireAdmin } from "./shared";

interface HandlerHistoryResolverContext {
  actor?: { id?: string; type?: string; groups?: string[] };
  tenantId?: string;
}

interface HandlerHistoryArgs {
  eventId: string;
}

interface ProjectedHistoryEntry {
  handler: string;
  status: string;
  durationMs: number | null;
  error: string | null;
}

/**
 * Project the service's `HandlerExecution` onto the UI's wire shape.
 *
 * `durationMs` is derived from `attemptedAt`/`completedAt` when both are
 * set; otherwise null (matches the UI contract: "null when the run never
 * completed").
 */
function projectHistory(entry: HandlerExecution): ProjectedHistoryEntry {
  const durationMs =
    entry.completedAt && entry.attemptedAt
      ? Math.max(0, entry.completedAt.getTime() - entry.attemptedAt.getTime())
      : null;
  return {
    handler: entry.handler,
    status: entry.status,
    durationMs,
    error: entry.errorMessage ?? null,
  };
}

export function buildEventHandlerHistoryField(
  service: EventReplayService,
): GraphQLFieldConfig<unknown, unknown> {
  return {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(HandlerHistoryEntryType))),
    description: "Per-handler delivery history for a single event. Admin-only; tenant-scoped.",
    args: {
      eventId: { type: new GraphQLNonNull(GraphQLID) },
    },
    resolve: async (
      _root: unknown,
      args: HandlerHistoryArgs,
      contextValue: unknown,
    ): Promise<ProjectedHistoryEntry[]> => {
      const ctx = (contextValue ?? {}) as HandlerHistoryResolverContext;
      requireAdmin(ctx.actor);

      // Resolve the event first to enforce tenant scoping. `get` returns
      // null for missing rows or malformed ids — surface both as "no
      // history" so a UI can render an empty state without a GraphQL error.
      const detail = await service.get(args.eventId);
      if (!detail) return [];
      if (!isVisibleToTenant(detail.tenantId, ctx.tenantId)) {
        throw new GraphQLError("Forbidden: event belongs to a different tenant.", {
          extensions: { code: "FORBIDDEN", http: { status: 403 } },
        });
      }

      const history = await service.handlerHistory({ eventId: args.eventId });
      return history.map(projectHistory);
    },
  };
}
