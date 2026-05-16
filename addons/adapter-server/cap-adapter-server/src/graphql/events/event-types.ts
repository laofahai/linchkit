/**
 * Shared GraphQL output types for the event-replay surface.
 *
 * Wire shape is locked by the cap-audit-ui `eventsClient` (see
 * `addons/audit/cap-audit-ui/src/lib/eventsClient.ts`). Field names
 * and nullability MUST stay aligned so the UI can render the timeline
 * end-to-end without translation.
 */

import {
  GraphQLBoolean,
  GraphQLID,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
} from "graphql";

// ── EventSummary ────────────────────────────────────────────

/**
 * Single persisted event row, projected to the camelCase shape used by the
 * UI. Mirrors `EventSummary` in `@linchkit/core/event` but with `createdAt`
 * and `processedAt` serialized as ISO strings (GraphQL String).
 */
export const EventSummaryType = new GraphQLObjectType({
  name: "EventSummary",
  description: "Persisted event summary as projected for the events timeline UI.",
  fields: () => ({
    id: { type: new GraphQLNonNull(GraphQLID) },
    tenantId: { type: GraphQLString },
    eventType: { type: new GraphQLNonNull(GraphQLString) },
    status: {
      type: new GraphQLNonNull(GraphQLString),
      description: "pending | processing | completed | failed | dead_letter",
    },
    sourceAction: { type: GraphQLString },
    sourceExecutionId: { type: GraphQLString },
    retryCount: { type: new GraphQLNonNull(GraphQLInt) },
    errorMessage: { type: GraphQLString },
    createdAt: {
      type: new GraphQLNonNull(GraphQLString),
      description: "ISO 8601 timestamp",
    },
    processedAt: {
      type: GraphQLString,
      description: "ISO 8601 timestamp; absent when the event has not been processed",
    },
  }),
});

// ── EventListResult ─────────────────────────────────────────

export const EventListResultType = new GraphQLObjectType({
  name: "EventListResult",
  description: "Paginated event list result.",
  fields: () => ({
    events: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(EventSummaryType))),
    },
    total: { type: new GraphQLNonNull(GraphQLInt) },
  }),
});

// ── HandlerHistoryEntry ─────────────────────────────────────

/**
 * Per-handler delivery summary. Until per-handler completion tracking exists
 * (Spec 66 §2.4) the service emits a single wildcard entry whose `handler`
 * is `"*"` — surface as-is so the UI can render an aggregate row.
 */
export const HandlerHistoryEntryType = new GraphQLObjectType({
  name: "HandlerHistoryEntry",
  description: "Per-handler delivery summary for a single event.",
  fields: () => ({
    handler: { type: new GraphQLNonNull(GraphQLString) },
    status: {
      type: new GraphQLNonNull(GraphQLString),
      description: "pending | processing | completed | failed | dead_letter",
    },
    durationMs: { type: GraphQLInt },
    error: { type: GraphQLString },
  }),
});

// ── ReplayHandlerOutcome ────────────────────────────────────

export const ReplayHandlerOutcomeType = new GraphQLObjectType({
  name: "ReplayHandlerOutcome",
  description: "Outcome of replaying an event through a single handler.",
  fields: () => ({
    handler: { type: new GraphQLNonNull(GraphQLString) },
    status: {
      type: new GraphQLNonNull(GraphQLString),
      description: `"success" when the handler ran without throwing; "error" otherwise`,
    },
    error: { type: GraphQLString },
  }),
});

// ── ReplayReport ────────────────────────────────────────────

export const ReplayReportType = new GraphQLObjectType({
  name: "ReplayReport",
  description: "Aggregate report for a single eventReplay invocation.",
  fields: () => ({
    eventId: { type: new GraphQLNonNull(GraphQLID) },
    dryRun: { type: new GraphQLNonNull(GraphQLBoolean) },
    delivered: { type: new GraphQLNonNull(GraphQLInt) },
    failed: { type: new GraphQLNonNull(GraphQLInt) },
    handlers: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(ReplayHandlerOutcomeType))),
    },
  }),
});
