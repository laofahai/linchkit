/**
 * Events GraphQL extension — wires `EventReplayService` into the served
 * schema as three operations expected by cap-audit-ui:
 *
 *   - `eventList(...)` query → paginated timeline
 *   - `eventHandlerHistory(eventId)` query → per-event handler summary
 *   - `eventReplay(eventId, dryRun, handlers)` mutation → re-dispatch
 *
 * Field names and arg names mirror
 * `addons/audit/cap-audit-ui/src/lib/eventsClient.ts` exactly — the UI
 * shape is authoritative.
 *
 * Registration pattern matches `cap-search` (see
 * `addons/search/cap-search/src/graphql.ts`): the build function returns
 * `{ queryFields, mutationFields }` so the host (build-schema or a
 * capability `graphqlExtensions` slot) can merge them into the schema.
 */

import type { EventReplayService } from "@linchkit/core";
import type { GraphQLFieldConfig } from "graphql";
import { buildEventHandlerHistoryField } from "./event-handler-history-resolver";
import { buildEventListField } from "./event-list-resolver";
import { buildEventReplayField } from "./event-replay-resolver";

export interface EventsGraphQLExtensionOptions {
  service: EventReplayService;
}

export interface EventsGraphQLExtension {
  queryFields: Record<string, GraphQLFieldConfig<unknown, unknown>>;
  mutationFields: Record<string, GraphQLFieldConfig<unknown, unknown>>;
}

/**
 * Build the events GraphQL extension. Returns the queries and mutation as
 * separate maps so callers can splice them into `Query`/`Mutation` types or
 * pass them as `extraQueryFields`/`extraMutationFields` to
 * `buildGraphQLSchema`.
 */
export function buildEventsGraphQLExtension(
  options: EventsGraphQLExtensionOptions,
): EventsGraphQLExtension {
  const { service } = options;
  return {
    queryFields: {
      eventList: buildEventListField(service),
      eventHandlerHistory: buildEventHandlerHistoryField(service),
    },
    mutationFields: {
      eventReplay: buildEventReplayField(service),
    },
  };
}

export { buildEventHandlerHistoryField } from "./event-handler-history-resolver";
export { buildEventListField } from "./event-list-resolver";
export { buildEventReplayField } from "./event-replay-resolver";
export {
  EventListResultType,
  EventSummaryType,
  HandlerHistoryEntryType,
  ReplayHandlerOutcomeType,
  ReplayReportType,
} from "./event-types";
