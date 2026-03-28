/**
 * Chatter GraphQL extension tests
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { buildChatterGraphQLExtension } from "../src/graphql";
import { InMemoryChatterService } from "../src/service";
import { graphql, GraphQLObjectType, GraphQLSchema, GraphQLString, GraphQLNonNull } from "graphql";

describe("buildChatterGraphQLExtension", () => {
  let service: InMemoryChatterService;

  beforeEach(() => {
    service = new InMemoryChatterService();
  });

  it("returns queryFields with chatterMessages", () => {
    const ext = buildChatterGraphQLExtension({ service });
    expect(ext.queryFields).toHaveProperty("chatterMessages");
  });

  it("returns type definitions", () => {
    const ext = buildChatterGraphQLExtension({ service });
    expect(ext.types).toHaveLength(2);
    const typeNames = ext.types.map((t) => t.name);
    expect(typeNames).toContain("ChatterMessage");
    expect(typeNames).toContain("ChatterMessageConnection");
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
          chatterMessages(schemaName: "purchase_request", recordId: "rec-001") {
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
        schemaName: "purchase_request",
        recordId: "rec-001",
        messageType: "comment",
        body: "Test comment",
        authorId: "user-001",
      });
      await service.createMessage({
        schemaName: "purchase_request",
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
          chatterMessages(schemaName: "purchase_request", recordId: "rec-001") {
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
      await service.createMessage({ schemaName: "s", recordId: "r", messageType: "comment", body: "c", authorId: "u" });
      await service.createMessage({ schemaName: "s", recordId: "r", messageType: "log", body: "l", authorId: "sys", authorType: "system" });

      const schema = buildTestSchema(service);
      const result = await graphql({
        schema,
        source: `{
          chatterMessages(schemaName: "s", recordId: "r", messageType: "comment") {
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
        await service.createMessage({ schemaName: "s", recordId: "r", messageType: "comment", body: `msg ${i}`, authorId: "u" });
      }

      const schema = buildTestSchema(service);
      const result = await graphql({
        schema,
        source: `{
          chatterMessages(schemaName: "s", recordId: "r", limit: 3, offset: 0) {
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
});
