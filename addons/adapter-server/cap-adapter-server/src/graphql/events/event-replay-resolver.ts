/**
 * `eventReplay(eventId: ID!, dryRun: Boolean, handlers: String)` GraphQL
 * mutation — re-dispatch a persisted event through its registered handlers.
 *
 * Fronts `EventReplayService.replay(id, { onlyHandler })`. The UI's wire
 * format uses `handlers` (singular handler name accepted today — see
 * `addons/audit/cap-audit-ui/src/lib/eventsClient.ts`). We forward the
 * value as-is to `onlyHandler`; multi-handler comma-separated input is a
 * future enhancement tracked as a TODO.
 *
 * `dryRun` semantics:
 *   The current `EventReplayService.replay` does not have a dry-run mode,
 *   so the resolver short-circuits BEFORE calling `replay()` when
 *   `dryRun === true`. It still loads the event (to honor permission
 *   and tenant checks and to surface "missing event" cleanly) and emits
 *   an empty `handlers` array with `delivered = failed = 0`. That matches
 *   the UI's "did not invoke handlers" contract.
 *
 * Tenant scoping: `replay` operates on a single row fetched via the
 * service's internal `fetchRow`, which has no tenant filter. The resolver
 * loads the event via `get` first to enforce tenant visibility.
 *
 * Error handling: any per-handler failures collected by the service are
 * projected into the `handlers` array as `status: "error"` entries — the
 * mutation itself does NOT throw when individual handlers fail.
 */

import type { EventReplayService, ReplayError, ReplayResult } from "@linchkit/core";
import {
  GraphQLBoolean,
  GraphQLError,
  type GraphQLFieldConfig,
  GraphQLID,
  GraphQLNonNull,
  GraphQLString,
} from "graphql";
import { ReplayReportType } from "./event-types";
import { isVisibleToTenant, requireAdmin } from "./shared";

interface ReplayResolverContext {
  actor?: { id?: string; type?: string; groups?: string[] };
  tenantId?: string;
}

interface ReplayArgs {
  eventId: string;
  dryRun?: boolean | null;
  // TODO(handlers): accept comma-separated handler names once the service
  // supports a multi-handler filter. Today a single handler name is expected.
  handlers?: string | null;
}

interface ProjectedReplayHandler {
  handler: string;
  status: "success" | "error";
  error: string | null;
}

interface ProjectedReplayReport {
  eventId: string;
  dryRun: boolean;
  delivered: number;
  failed: number;
  handlers: ProjectedReplayHandler[];
}

/**
 * Project the service's `ReplayResult` onto the UI's `ReplayReport` shape.
 * Successes get `status: "success"`; the per-handler error list maps to
 * `status: "error"` entries with the captured message.
 *
 * The service's `delivered` is a count, not a per-handler breakdown — we
 * don't know the handler names that succeeded. To keep the UI's contract
 * informative we still emit one synthetic success entry per delivered
 * invocation; without per-handler success identifiers, callers should treat
 * these as opaque markers (the count is what matters).
 */
function projectReplay(
  eventId: string,
  dryRun: boolean,
  result: ReplayResult,
): ProjectedReplayReport {
  const errors: ProjectedReplayHandler[] = result.errors.map((err: ReplayError) => ({
    handler: err.handler,
    status: "error" as const,
    error: err.message,
  }));
  // Synthesize anonymous success entries so the `handlers` array length
  // matches `delivered + failed` — the UI uses this as a "what ran" list.
  const successes: ProjectedReplayHandler[] = Array.from({ length: result.delivered }, (_, i) => ({
    handler: `delivered[${i}]`,
    status: "success" as const,
    error: null,
  }));
  return {
    eventId,
    dryRun,
    delivered: result.delivered,
    failed: result.errors.length,
    handlers: [...successes, ...errors],
  };
}

export function buildEventReplayField(
  service: EventReplayService,
): GraphQLFieldConfig<unknown, unknown> {
  return {
    type: new GraphQLNonNull(ReplayReportType),
    description:
      "Re-dispatch a persisted event through its registered handlers. Admin-only; tenant-scoped. " +
      "When `dryRun` is true the resolver returns a zero-delivery report WITHOUT invoking handlers.",
    args: {
      eventId: { type: new GraphQLNonNull(GraphQLID) },
      dryRun: { type: GraphQLBoolean },
      handlers: {
        type: GraphQLString,
        description:
          "Restrict the replay to a single handler name. Multi-handler / comma-separated input is not yet supported.",
      },
    },
    resolve: async (
      _root: unknown,
      args: ReplayArgs,
      contextValue: unknown,
    ): Promise<ProjectedReplayReport> => {
      const ctx = (contextValue ?? {}) as ReplayResolverContext;
      requireAdmin(ctx.actor);

      const dryRun = args.dryRun === true;
      const onlyHandler =
        typeof args.handlers === "string" && args.handlers.length > 0 ? args.handlers : undefined;

      // Resolve and tenant-check BEFORE replay so cross-tenant invocation
      // is impossible. `get` returns null for missing rows or malformed
      // ids — surface as a GraphQL error so the UI can show a clear message.
      const detail = await service.get(args.eventId);
      if (!detail) {
        throw new GraphQLError(`Event "${args.eventId}" not found.`, {
          extensions: { code: "NOT_FOUND", http: { status: 404 } },
        });
      }
      if (!isVisibleToTenant(detail.tenantId, ctx.tenantId)) {
        throw new GraphQLError("Forbidden: event belongs to a different tenant.", {
          extensions: { code: "FORBIDDEN", http: { status: 403 } },
        });
      }

      if (dryRun) {
        return {
          eventId: args.eventId,
          dryRun: true,
          delivered: 0,
          failed: 0,
          handlers: [],
        };
      }

      const result = await service.replay(args.eventId, { onlyHandler });
      return projectReplay(args.eventId, false, result);
    },
  };
}
