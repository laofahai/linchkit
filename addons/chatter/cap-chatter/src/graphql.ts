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
 * Authorization hook the host (cap-adapter-server) injects on the per-request
 * GraphQL context so a chatter write passes through the CommandLayer permission
 * slot — exactly like every action-backed mutation does — WITHOUT cap-chatter
 * importing the server (module boundary).
 *
 * cap-chatter owns the WRITE entry (`chatterAddMessage`), but the message store
 * is a plain Drizzle table, not a meta-model action, so the GraphQL resolver
 * cannot route through `dispatchAction → commandLayer.execute`. Instead the
 * server contributes this hook; its implementation runs a standalone permission
 * check (CommandLayer non-action dispatch) gating an entity-level WRITE on the
 * record's entity. The hook MUST reject (throw) when the actor is not permitted.
 *
 * Defined locally as a structural type so cap-chatter depends on the SHAPE, not
 * the server package.
 */
export type AuthorizeChatterWrite = (input: {
  /** The entity the comment/note is posted against (e.g. "purchase_order"). */
  entityName: string;
  /** The record id within that entity. */
  recordId: string;
  /** The request actor (already resolved by the auth slot upstream). */
  actor: { id: string; type: string; name?: string; tenantId?: string };
  /** Tenant scope for the write, when present. */
  tenantId?: string;
}) => Promise<void>;

/**
 * Minimal view of the per-request GraphQL context this extension reads.
 *
 * cap-chatter must not depend on cap-adapter-server (module boundary), so we
 * narrow to only the fields we consume. The server's full `GraphQLContext`
 * (which carries `actor`, `tenantId`, and now `authorizeChatterWrite`) is
 * structurally compatible with this.
 */
interface ChatterGraphQLContext {
  // The server's GraphQLContext always populates `actor` — an authenticated
  // user, or the anonymous sentinel for unauthenticated requests. It is never
  // absent in normal operation, so it is required here (the resolver still
  // guards defensively against a malformed, contextless call).
  actor: { id: string; type: string; name?: string; tenantId?: string };
  tenantId?: string;
  /**
   * Permission gate injected by the host. When present, the `chatterAddMessage`
   * resolver invokes it BEFORE writing so the CommandLayer permission slot runs.
   * Absent only in degraded setups that wire no host (the resolver fails closed).
   */
  authorizeChatterWrite?: AuthorizeChatterWrite;
}

// ── Shared GraphQL types ────────────────────────────────────

/**
 * All message kinds. Used for the `messageType` OUTPUT field and the
 * `chatterMessages` query filter (a client may filter by any kind, including the
 * system-produced `log`/`ai`). NOT used as the `chatterAddMessage` input — see
 * {@link AuthorableMessageTypeEnum}, which expresses the authoring constraint in
 * the type system rather than only at runtime.
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
 * The message kinds a CLIENT may author via `chatterAddMessage`. `log`/`ai` are
 * system-produced (e.g. the auto-log event handler) and must never come from a
 * client request, so they are absent here — an introspection-based client (codegen,
 * GraphQL Playground) sees only the genuinely-accepted values, and `log`/`ai` are
 * rejected at the schema layer, not silently accepted then thrown at runtime. The
 * resolver keeps a defensive runtime check as defense-in-depth.
 */
const AuthorableMessageTypeEnum = new GraphQLEnumType({
  name: "AuthorableMessageType",
  description: "Message kinds a client may author (comments and notes only)",
  values: {
    comment: { value: "comment" },
    note: { value: "note" },
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
        // Restricted input enum (comment/note only) — the authoring constraint is
        // expressed in the schema, so `log`/`ai` are rejected at validation time
        // and never appear as valid inputs to an introspection client.
        type: new GraphQLNonNull(AuthorableMessageTypeEnum),
        description: "Message kind to author — `comment` or `note`",
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
      // Treat it as Partial here so the runtime actor guard below is meaningful
      // even though the interface declares `actor` as always-present.
      const context = (rawContext ?? {}) as Partial<ChatterGraphQLContext>;
      // Authored content is restricted to comments/notes. The `AuthorableMessageType`
      // input enum already rejects `log`/`ai` at schema-validation time; this runtime
      // check is defense-in-depth for any non-schema caller (e.g. a direct resolver
      // invocation in a test or future transport).
      if (args.messageType !== "comment" && args.messageType !== "note") {
        throw new Error(
          `Cannot author a "${args.messageType}" message — only "comment" or "note" are allowed.`,
        );
      }

      // Bound each length on the RAW input, before trimming — otherwise a padded
      // payload (e.g. 5k real chars + tens of MB of trailing whitespace) would
      // force an O(n) trim over the whole blob before these O(1) checks fire.
      // Per-field messages so the caller knows which input was too long.
      const MAX_BODY_LENGTH = 10_000;
      const MAX_REF_LENGTH = 255;
      if (args.body.length > MAX_BODY_LENGTH) {
        throw new Error(`Message body exceeds the ${MAX_BODY_LENGTH}-character limit.`);
      }
      if (args.entityName.length > MAX_REF_LENGTH) {
        throw new Error(`entityName exceeds the ${MAX_REF_LENGTH}-character limit.`);
      }
      if (args.recordId.length > MAX_REF_LENGTH) {
        throw new Error(`recordId exceeds the ${MAX_REF_LENGTH}-character limit.`);
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

      // Author identity is server-managed — derived from the request actor,
      // never accepted from the client. Guard defensively: a contextless call
      // (no actor at all) is rejected rather than silently attributed.
      const actor = context.actor;
      if (!actor) {
        throw new Error("chatterAddMessage requires an actor on the request context.");
      }

      // Permission slot: route the write through the host-injected authorize
      // hook so the CommandLayer permission slot runs — the same guarantee
      // every action-backed mutation gets. The hook gates an entity-level WRITE
      // on the target record's entity (the comment is "written against" that
      // record) and THROWS when the actor is not permitted. Fail closed: if no
      // host wired the hook, refuse the write rather than silently allow it.
      // Run on the trimmed/validated values, after the DoS-ordering checks above.
      const authorize = context.authorizeChatterWrite;
      if (!authorize) {
        throw new Error(
          "chatterAddMessage is not permission-wired — the host did not inject an authorize hook.",
        );
      }
      await authorize({
        entityName,
        recordId,
        actor,
        tenantId: context.tenantId ?? actor.tenantId,
      });

      const message = await service.createMessage({
        entityName,
        recordId,
        messageType: args.messageType,
        body,
        authorId: actor.id,
        authorType: actor.type,
        authorName: actor.name,
        // tenantId is optional by design: a single-tenant / tenant-less
        // deployment (e.g. the local demo) legitimately has no tenant, so an
        // undefined value is accepted and stored as NULL. A tenant-scoped read
        // filter (tracked separately) must treat NULL-tenant rows consistently
        // for that mode.
        tenantId: context.tenantId ?? actor.tenantId,
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
