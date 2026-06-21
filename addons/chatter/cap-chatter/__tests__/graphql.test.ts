/**
 * Chatter GraphQL extension tests
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { GraphQLNonNull, GraphQLObjectType, GraphQLSchema, GraphQLString, graphql } from "graphql";
import { buildChatterGraphQLExtension } from "../src/graphql";
import { InMemoryChatterService } from "../src/service";

describe("buildChatterGraphQLExtension", () => {
  let service: InMemoryChatterService;

  beforeEach(() => {
    service = new InMemoryChatterService();
  });

  it("returns queryFields with chatterMessages", () => {
    const ext = buildChatterGraphQLExtension({ service });
    expect(ext.queryFields).toHaveProperty("chatterMessages");
  });

  it("returns mutationFields with chatterAddMessage", () => {
    const ext = buildChatterGraphQLExtension({ service });
    expect(ext.mutationFields).toHaveProperty("chatterAddMessage");
  });

  it("returns type definitions", () => {
    const ext = buildChatterGraphQLExtension({ service });
    expect(ext.types).toHaveLength(3);
    const typeNames = ext.types.map((t) => t.name);
    expect(typeNames).toContain("ChatterMessage");
    expect(typeNames).toContain("ChatterMessageConnection");
    expect(typeNames).toContain("ChatterMessageAuthor");
  });

  describe("chatterMessages resolver", () => {
    function buildTestSchema(svc: InMemoryChatterService): GraphQLSchema {
      const ext = buildChatterGraphQLExtension({ service: svc });
      return new GraphQLSchema({
        query: new GraphQLObjectType({
          name: "Query",
          fields: {
            ping: { type: new GraphQLNonNull(GraphQLString), resolve: () => "pong" },
            ...ext.queryFields,
          },
        }),
      });
    }

    it("returns empty result for a record with no messages", async () => {
      const schema = buildTestSchema(service);
      const result = await graphql({
        schema,
        source: `{
          chatterMessages(entityName: "purchase_request", recordId: "rec-001") {
            totalCount
            hasMore
            items { id body messageType }
          }
        }`,
      });

      expect(result.errors).toBeUndefined();
      const data = result.data?.chatterMessages as Record<string, unknown>;
      expect(data.totalCount).toBe(0);
      expect(data.hasMore).toBe(false);
      expect(data.items).toEqual([]);
    });

    it("returns messages for a record", async () => {
      await service.createMessage({
        entityName: "purchase_request",
        recordId: "rec-001",
        messageType: "comment",
        body: "Test comment",
        authorId: "user-001",
      });
      await service.createMessage({
        entityName: "purchase_request",
        recordId: "rec-001",
        messageType: "log",
        body: "Created this record.",
        authorId: "system",
        authorType: "system",
        logEvent: "record.created",
      });

      const schema = buildTestSchema(service);
      const result = await graphql({
        schema,
        source: `{
          chatterMessages(entityName: "purchase_request", recordId: "rec-001") {
            totalCount
            hasMore
            items { id body messageType authorId }
          }
        }`,
      });

      expect(result.errors).toBeUndefined();
      const data = result.data?.chatterMessages as Record<string, unknown>;
      expect(data.totalCount).toBe(2);
      expect((data.items as unknown[]).length).toBe(2);
    });

    it("filters by messageType", async () => {
      await service.createMessage({
        entityName: "s",
        recordId: "r",
        messageType: "comment",
        body: "c",
        authorId: "u",
      });
      await service.createMessage({
        entityName: "s",
        recordId: "r",
        messageType: "log",
        body: "l",
        authorId: "sys",
        authorType: "system",
      });

      const schema = buildTestSchema(service);
      const result = await graphql({
        schema,
        source: `{
          chatterMessages(entityName: "s", recordId: "r", messageType: comment) {
            totalCount
            items { messageType }
          }
        }`,
      });

      expect(result.errors).toBeUndefined();
      const data = result.data?.chatterMessages as Record<string, unknown>;
      expect(data.totalCount).toBe(1);
    });

    it("paginates via limit and offset", async () => {
      for (let i = 0; i < 5; i++) {
        await service.createMessage({
          entityName: "s",
          recordId: "r",
          messageType: "comment",
          body: `msg ${i}`,
          authorId: "u",
        });
      }

      const schema = buildTestSchema(service);
      const result = await graphql({
        schema,
        source: `{
          chatterMessages(entityName: "s", recordId: "r", limit: 3, offset: 0) {
            totalCount
            hasMore
            items { body }
          }
        }`,
      });

      expect(result.errors).toBeUndefined();
      const data = result.data?.chatterMessages as Record<string, unknown>;
      expect(data.totalCount).toBe(5);
      expect((data.items as unknown[]).length).toBe(3);
      expect(data.hasMore).toBe(true);
    });
  });

  describe("chatterAddMessage mutation", () => {
    /** Build a schema with both Query and Mutation wired, mirroring assemble-schema. */
    function buildFullSchema(svc: InMemoryChatterService): GraphQLSchema {
      const ext = buildChatterGraphQLExtension({ service: svc });
      return new GraphQLSchema({
        query: new GraphQLObjectType({
          name: "Query",
          fields: {
            ping: { type: new GraphQLNonNull(GraphQLString), resolve: () => "pong" },
            ...ext.queryFields,
          },
        }),
        mutation: new GraphQLObjectType({
          name: "Mutation",
          fields: { ...ext.mutationFields },
        }),
      });
    }

    // Exact selection set the UI client (cap-adapter-ui/lib/chatter-api.ts) sends.
    const CLIENT_FIELDS = `
      id entityName recordId messageType body
      author { id type name }
      logEvent logMetadata
      createdAt updatedAt
    `;

    it("persists a note and returns the shape the UI client selects", async () => {
      const schema = buildFullSchema(service);
      const result = await graphql({
        schema,
        source: `
          mutation AddChatterMessage($entityName: String!, $recordId: String!, $messageType: MessageType!, $body: String!) {
            chatterAddMessage(entityName: $entityName, recordId: $recordId, messageType: $messageType, body: $body) {
              ${CLIENT_FIELDS}
            }
          }
        `,
        variableValues: {
          entityName: "partner",
          recordId: "rec-partner-1",
          messageType: "note",
          body: "Reliable supplier — pays within 30 days.",
        },
        // Mirrors the server's GraphQLContext (structurally narrowed).
        contextValue: {
          actor: { id: "user-42", type: "user", name: "Alice" },
          tenantId: "tenant-1",
        },
      });

      expect(result.errors).toBeUndefined();
      const msg = result.data?.chatterAddMessage as Record<string, unknown>;
      expect(msg.id).toBeString();
      expect(msg.entityName).toBe("partner");
      expect(msg.recordId).toBe("rec-partner-1");
      expect(msg.messageType).toBe("note");
      expect(msg.body).toBe("Reliable supplier — pays within 30 days.");
      // Nested author object resolved from flat author fields (matches client).
      expect(msg.author).toEqual({ id: "user-42", type: "user", name: "Alice" });
      expect(msg.createdAt).toBeString();
      expect(msg.updatedAt).toBeString();
    });

    it("round-trips: an added note is readable via chatterMessages", async () => {
      const schema = buildFullSchema(service);
      const add = await graphql({
        schema,
        source: `
          mutation {
            chatterAddMessage(entityName: "partner", recordId: "rec-rt", messageType: note, body: "round trip") {
              id
            }
          }
        `,
        contextValue: { actor: { id: "user-1", type: "user" } },
      });
      expect(add.errors).toBeUndefined();
      const addedId = (add.data?.chatterAddMessage as Record<string, unknown>).id;

      const read = await graphql({
        schema,
        source: `{
          chatterMessages(entityName: "partner", recordId: "rec-rt") {
            totalCount
            items { id body messageType author { id } }
          }
        }`,
      });
      expect(read.errors).toBeUndefined();
      const data = read.data?.chatterMessages as Record<string, unknown>;
      expect(data.totalCount).toBe(1);
      const items = data.items as Array<Record<string, unknown>>;
      const first = items[0];
      expect(first).toBeDefined();
      expect(first?.id).toBe(addedId);
      expect(first?.body).toBe("round trip");
      expect(first?.messageType).toBe("note");
      expect(first?.author).toEqual({ id: "user-1" });
    });

    it("derives author from context, ignoring any client-supplied author", async () => {
      const schema = buildFullSchema(service);
      // The mutation exposes no author argument, so author identity comes from
      // the server-side actor only.
      const result = await graphql({
        schema,
        source: `
          mutation {
            chatterAddMessage(entityName: "partner", recordId: "rec-auth", messageType: comment, body: "hi") {
              author { id type name }
            }
          }
        `,
        contextValue: { actor: { id: "svc-9", type: "system", name: "System" } },
      });
      expect(result.errors).toBeUndefined();
      const msg = result.data?.chatterAddMessage as Record<string, unknown>;
      expect(msg.author).toEqual({ id: "svc-9", type: "system", name: "System" });
    });

    it("rejects authoring a non-comment/note message kind", async () => {
      const schema = buildFullSchema(service);
      const result = await graphql({
        schema,
        source: `
          mutation {
            chatterAddMessage(entityName: "partner", recordId: "r", messageType: log, body: "x") {
              id
            }
          }
        `,
        contextValue: { actor: { id: "u", type: "user" } },
      });
      expect(result.errors).toBeDefined();
      expect(result.errors?.[0]?.message).toContain("only");
    });

    it("rejects an empty body", async () => {
      const schema = buildFullSchema(service);
      const result = await graphql({
        schema,
        source: `
          mutation {
            chatterAddMessage(entityName: "partner", recordId: "r", messageType: note, body: "   ") {
              id
            }
          }
        `,
        contextValue: { actor: { id: "u", type: "user" } },
      });
      expect(result.errors).toBeDefined();
      expect(result.errors?.[0]?.message).toContain("empty");
    });

    it("rejects an oversized body (storage / DoS guard)", async () => {
      const schema = buildFullSchema(service);
      const result = await graphql({
        schema,
        source: `
          mutation Add($body: String!) {
            chatterAddMessage(entityName: "partner", recordId: "r", messageType: note, body: $body) {
              id
            }
          }
        `,
        variableValues: { body: "x".repeat(10_001) },
        contextValue: { actor: { id: "u", type: "user" } },
      });
      expect(result.errors).toBeDefined();
      expect(result.errors?.[0]?.message).toContain("limit");
    });

    it("rejects a contextless call with no actor", async () => {
      const schema = buildFullSchema(service);
      const result = await graphql({
        schema,
        source: `
          mutation {
            chatterAddMessage(entityName: "partner", recordId: "r", messageType: note, body: "hi") {
              id
            }
          }
        `,
        // No contextValue → no actor. The resolver must reject rather than
        // silently persist an unattributed message.
        contextValue: {},
      });
      expect(result.errors).toBeDefined();
      expect(result.errors?.[0]?.message).toContain("actor");
    });
  });
});
