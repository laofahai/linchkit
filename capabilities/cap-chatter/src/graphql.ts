/**
 * Chatter GraphQL extension
 *
 * Provides GraphQL type definitions and resolvers for the chatter API.
 * Returns field configs that can be merged into the main GraphQL schema's
 * Query type using graphql-js utilities.
 *
 * Usage:
 *   const chatterFields = buildChatterGraphQLExtension({ service });
 *   // Merge chatterFields.queryFields into your Query type fields
 */

import type { GraphQLFieldConfig, GraphQLResolveInfo } from "graphql";
import {
  GraphQLBoolean,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
} from "graphql";
import type { ChatterService } from "./types";

// ── Shared GraphQL types ────────────────────────────────────

const ChatterMessageType = new GraphQLObjectType({
  name: "ChatterMessage",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLString) },
    schemaName: { type: new GraphQLNonNull(GraphQLString) },
    recordId: { type: new GraphQLNonNull(GraphQLString) },
    messageType: { type: new GraphQLNonNull(GraphQLString) },
    body: { type: new GraphQLNonNull(GraphQLString) },
    bodyHtml: { type: GraphQLString },
    authorId: { type: new GraphQLNonNull(GraphQLString) },
    authorType: { type: new GraphQLNonNull(GraphQLString) },
    authorName: { type: GraphQLString },
    parentId: { type: GraphQLString },
    threadCount: { type: new GraphQLNonNull(GraphQLInt) },
    logEvent: { type: GraphQLString },
    logMetadata: { type: GraphQLString, description: "JSON-encoded log metadata" },
    createdAt: { type: new GraphQLNonNull(GraphQLString) },
    updatedAt: { type: new GraphQLNonNull(GraphQLString) },
  },
});

const ChatterMessageConnectionType = new GraphQLObjectType({
  name: "ChatterMessageConnection",
  fields: {
    items: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(ChatterMessageType))) },
    totalCount: { type: new GraphQLNonNull(GraphQLInt) },
    hasMore: { type: new GraphQLNonNull(GraphQLBoolean) },
  },
});

// ── Extension builder ───────────────────────────────────────

export interface ChatterGraphQLExtensionOptions {
  service: ChatterService;
}

export interface ChatterGraphQLExtension {
  /** GraphQL types contributed by cap-chatter */
  types: GraphQLObjectType[];
  /** Query fields to merge into the root Query type */
  queryFields: Record<string, GraphQLFieldConfig<unknown, unknown>>;
}

/**
 * Build the GraphQL extension for cap-chatter.
 *
 * Returns query fields that consumer can merge into the main GraphQL schema.
 */
export function buildChatterGraphQLExtension(
  options: ChatterGraphQLExtensionOptions,
): ChatterGraphQLExtension {
  const { service } = options;

  const chatterMessages: GraphQLFieldConfig<unknown, unknown> = {
    type: new GraphQLNonNull(ChatterMessageConnectionType),
    description: "Paginated chatter messages for a record",
    args: {
      schemaName: { type: new GraphQLNonNull(GraphQLString) },
      recordId: { type: new GraphQLNonNull(GraphQLString) },
      messageType: {
        type: GraphQLString,
        description: "Filter by type: comment | note | log | ai",
      },
      limit: { type: GraphQLInt, defaultValue: 20 },
      offset: { type: GraphQLInt, defaultValue: 0 },
    },
    resolve: async (
      _source: unknown,
      args: {
        schemaName: string;
        recordId: string;
        messageType?: string;
        limit?: number;
        offset?: number;
      },
      _context: unknown,
      _info: GraphQLResolveInfo,
    ) => {
      const result = await service.getMessages(args.schemaName, args.recordId, {
        messageType: args.messageType as "comment" | "note" | "log" | "ai" | undefined,
        limit: args.limit,
        offset: args.offset,
      });

      return {
        items: result.items.map((msg) => ({
          ...msg,
          createdAt: msg.createdAt.toISOString(),
          updatedAt: msg.updatedAt.toISOString(),
          logMetadata: msg.logMetadata ? JSON.stringify(msg.logMetadata) : null,
        })),
        totalCount: result.totalCount,
        hasMore: result.hasMore,
      };
    },
  };

  return {
    types: [ChatterMessageType, ChatterMessageConnectionType],
    queryFields: { chatterMessages },
  };
}
