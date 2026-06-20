/**
 * Chatter GraphQL extension
 *
 * Provides GraphQL type definitions and resolvers for the chatter API.
 * Returns field configs that can be merged into the main GraphQL schema's
 * Query and Mutation types using graphql-js utilities.
 *
 * Usage:
 *   const chatterFields = buildChatterGraphQLExtension({ service });
 *   // Merge chatterFields.queryFields into your Query type fields
 *   // Merge chatterFields.mutationFields into your Mutation type fields
 */

import type { GraphQLFieldConfig, GraphQLResolveInfo } from "graphql";
import {
  GraphQLBoolean,
  GraphQLEnumType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
} from "graphql";
import type { ChatterMessage, ChatterService, MessageType } from "./types";

/**
 * Minimal view of the per-request GraphQL context this extension reads.
 *
 * cap-chatter must not depend on cap-adapter-server (module boundary), so we
 * narrow to only the fields we consume. The server's full `GraphQLContext`
 * (which carries `actor` and `tenantId`) is structurally compatible with this.
 */
interface ChatterGraphQLContext {
  actor?: { id: string; type: string; name?: string; tenantId?: string };
  tenantId?: string;
}

// ── Shared GraphQL types ────────────────────────────────────

/**
 * Message kinds. Shared by the `messageType` output field and the
 * `chatterAddMessage` input argument. A single enum instance is intentionally
 * reused for both input and output positions — graphql-js permits enums in
 * either role, and reuse keeps the schema's type set minimal.
 */
const MessageTypeEnum = new GraphQLEnumType({
  name: "MessageType",
  description: "Kind of a chatter message",
  values: {
    comment: { value: "comment" },
    note: { value: "note" },
    log: { value: "log" },
    ai: { value: "ai" },
  },
});

/**
 * Author of a message, projected from the flat `authorId`/`authorType`/
 * `authorName` fields the service persists. Exposed as a nested object so the
 * client can select `author { id type name }`.
 */
const ChatterMessageAuthorType = new GraphQLObjectType({
  name: "ChatterMessageAuthor",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLString) },
    type: { type: new GraphQLNonNull(GraphQLString) },
    name: { type: GraphQLString },
  },
});

const ChatterMessageType = new GraphQLObjectType({
  name: "ChatterMessage",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLString) },
    entityName: { type: new GraphQLNonNull(GraphQLString) },
    recordId: { type: new GraphQLNonNull(GraphQLString) },
    messageType: { type: new GraphQLNonNull(MessageTypeEnum) },
    body: { type: new GraphQLNonNull(GraphQLString) },
    bodyHtml: { type: GraphQLString },
    // Flat author fields (kept for backward compatibility) ...
    authorId: { type: new GraphQLNonNull(GraphQLString) },
    authorType: { type: new GraphQLNonNull(GraphQLString) },
    authorName: { type: GraphQLString },
    // ... and the nested projection the client selects.
    author: {
      type: new GraphQLNonNull(ChatterMessageAuthorType),
      resolve: (source: SerializedChatterMessage) => ({
        id: source.authorId,
        type: source.authorType,
        name: source.authorName ?? null,
      }),
    },
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

// ── Serialization ───────────────────────────────────────────

/**
 * Wire shape of a {@link ChatterMessage}: `Date`s become ISO strings and
 * `logMetadata` is JSON-encoded into a string (matching the `logMetadata`
 * scalar field). Used as the resolved value for both the query and mutation.
 */
interface SerializedChatterMessage
  extends Omit<ChatterMessage, "createdAt" | "updatedAt" | "logMetadata"> {
  createdAt: string;
  updatedAt: string;
  logMetadata: string | null;
}

function serializeMessage(msg: ChatterMessage): SerializedChatterMessage {
  return {
    ...msg,
    createdAt: msg.createdAt.toISOString(),
    updatedAt: msg.updatedAt.toISOString(),
    logMetadata: msg.logMetadata ? JSON.stringify(msg.logMetadata) : null,
  };
}

// ── Extension builder ───────────────────────────────────────

export interface ChatterGraphQLExtensionOptions {
  service: ChatterService;
}

export interface ChatterGraphQLExtension {
  /** GraphQL types contributed by cap-chatter */
  types: GraphQLObjectType[];
  /** Query fields to merge into the root Query type */
  queryFields: Record<string, GraphQLFieldConfig<unknown, unknown>>;
  /** Mutation fields to merge into the root Mutation type */
  mutationFields: Record<string, GraphQLFieldConfig<unknown, unknown>>;
}

/**
 * Build the GraphQL extension for cap-chatter.
 *
 * Returns query and mutation fields the consumer can merge into the main
 * GraphQL schema.
 */
export function buildChatterGraphQLExtension(
  options: ChatterGraphQLExtensionOptions,
): ChatterGraphQLExtension {
  const { service } = options;

  const chatterMessages: GraphQLFieldConfig<unknown, unknown> = {
    type: new GraphQLNonNull(ChatterMessageConnectionType),
    description: "Paginated chatter messages for a record",
    args: {
      entityName: { type: new GraphQLNonNull(GraphQLString) },
      recordId: { type: new GraphQLNonNull(GraphQLString) },
      messageType: {
        type: MessageTypeEnum,
        description: "Filter by message kind",
      },
      limit: { type: GraphQLInt, defaultValue: 20 },
      offset: { type: GraphQLInt, defaultValue: 0 },
    },
    resolve: async (
      _source: unknown,
      args: {
        entityName: string;
        recordId: string;
        messageType?: MessageType;
        limit?: number;
        offset?: number;
      },
      _context: unknown,
      _info: GraphQLResolveInfo,
    ) => {
      const result = await service.getMessages(args.entityName, args.recordId, {
        messageType: args.messageType,
        limit: args.limit,
        offset: args.offset,
      });

      return {
        items: result.items.map(serializeMessage),
        totalCount: result.totalCount,
        hasMore: result.hasMore,
      };
    },
  };

  const chatterAddMessage: GraphQLFieldConfig<unknown, unknown> = {
    type: new GraphQLNonNull(ChatterMessageType),
    description: "Post a comment or note against a record",
    args: {
      entityName: { type: new GraphQLNonNull(GraphQLString) },
      recordId: { type: new GraphQLNonNull(GraphQLString) },
      messageType: {
        type: new GraphQLNonNull(MessageTypeEnum),
        description: "Message kind — only `comment` or `note` may be authored by a client",
      },
      body: { type: new GraphQLNonNull(GraphQLString) },
    },
    resolve: async (
      _source: unknown,
      args: {
        entityName: string;
        recordId: string;
        messageType: MessageType;
        body: string;
      },
      rawContext: unknown,
      _info: GraphQLResolveInfo,
    ): Promise<SerializedChatterMessage> => {
      // Narrow the opaque per-request context to only the fields we read. The
      // server passes its full `GraphQLContext` (which carries `actor`/`tenantId`).
      const context = (rawContext ?? {}) as ChatterGraphQLContext;
      // Authored content is restricted to comments/notes. `log`/`ai` entries are
      // produced by the system (e.g. the auto-log event handler), never by a
      // client request, so reject them here.
      if (args.messageType !== "comment" && args.messageType !== "note") {
        throw new Error(
          `Cannot author a "${args.messageType}" message — only "comment" or "note" are allowed.`,
        );
      }

      // Sanitize text inputs and reject empty/whitespace-only bodies.
      const entityName = args.entityName.trim();
      const recordId = args.recordId.trim();
      const body = args.body.trim();
      if (!entityName || !recordId) {
        throw new Error("entityName and recordId are required.");
      }
      if (!body) {
        throw new Error("Message body cannot be empty.");
      }
      // Bound the body length so a single request cannot insert an unbounded
      // blob (storage / DoS guard).
      const MAX_BODY_LENGTH = 10_000;
      if (body.length > MAX_BODY_LENGTH) {
        throw new Error(`Message body exceeds the ${MAX_BODY_LENGTH}-character limit.`);
      }

      // Author identity is server-managed — derived from the authenticated
      // actor, never accepted from the client.
      const actor = context?.actor;
      const message = await service.createMessage({
        entityName,
        recordId,
        messageType: args.messageType,
        body,
        authorId: actor?.id ?? "anonymous",
        authorType: actor?.type ?? "system",
        authorName: actor?.name,
        tenantId: context?.tenantId ?? actor?.tenantId,
      });

      return serializeMessage(message);
    },
  };

  return {
    types: [ChatterMessageAuthorType, ChatterMessageType, ChatterMessageConnectionType],
    queryFields: { chatterMessages },
    mutationFields: { chatterAddMessage },
  };
}
