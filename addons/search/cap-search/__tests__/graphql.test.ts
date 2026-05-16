/**
 * cap-search GraphQL extension tests — exercises the resolver via a real
 * GraphQL execution to confirm the field signature, tenant scoping, and
 * argument forwarding.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { GraphQLNonNull, GraphQLObjectType, GraphQLSchema, GraphQLString, graphql } from "graphql";
import { buildSearchGraphQLExtension } from "../src/graphql";
import { InMemorySearchService } from "../src/service";

function buildTestSchema(service: InMemorySearchService): GraphQLSchema {
  const ext = buildSearchGraphQLExtension({ service });
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

describe("buildSearchGraphQLExtension", () => {
  let service: InMemorySearchService;

  beforeEach(() => {
    service = new InMemorySearchService();
  });

  it("registers a `search` query field and a SearchHit type", () => {
    const ext = buildSearchGraphQLExtension({ service });
    expect(ext.queryFields).toHaveProperty("search");
    expect(ext.types.map((t) => t.name)).toContain("SearchHit");
  });

  it("returns hits for a matching query", async () => {
    await service.upsertDocument({
      tenantId: "t1",
      entity: "purchase_request",
      recordId: "rec-001",
      content: "ergonomic office chair",
    });

    const schema = buildTestSchema(service);
    const result = await graphql({
      schema,
      source: `{
        search(q: "chair") {
          entity
          recordId
          score
        }
      }`,
      contextValue: { tenantId: "t1" },
    });

    expect(result.errors).toBeUndefined();
    const data = result.data?.search as Array<{
      entity: string;
      recordId: string;
      score: number;
    }>;
    expect(data).toHaveLength(1);
    expect(data[0]?.entity).toBe("purchase_request");
    expect(data[0]?.recordId).toBe("rec-001");
    expect(typeof data[0]?.score).toBe("number");
  });

  it("scopes results to the tenant in context", async () => {
    await service.upsertDocument({
      tenantId: "t1",
      entity: "doc",
      recordId: "a",
      content: "shared keyword",
    });
    await service.upsertDocument({
      tenantId: "t2",
      entity: "doc",
      recordId: "b",
      content: "shared keyword",
    });

    const schema = buildTestSchema(service);
    const result = await graphql({
      schema,
      source: `{ search(q: "shared") { recordId } }`,
      contextValue: { tenantId: "t2" },
    });

    expect(result.errors).toBeUndefined();
    const hits = result.data?.search as Array<{ recordId: string }>;
    expect(hits).toHaveLength(1);
    expect(hits[0]?.recordId).toBe("b");
  });

  it("forwards the entity argument to the service", async () => {
    await service.upsertDocument({
      tenantId: "t1",
      entity: "vendor",
      recordId: "v1",
      content: "office supplies",
    });
    await service.upsertDocument({
      tenantId: "t1",
      entity: "purchase_request",
      recordId: "p1",
      content: "office supplies",
    });

    const schema = buildTestSchema(service);
    const result = await graphql({
      schema,
      source: `{ search(q: "office", entity: "vendor") { entity recordId } }`,
      contextValue: { tenantId: "t1" },
    });

    expect(result.errors).toBeUndefined();
    const hits = result.data?.search as Array<{ entity: string }>;
    expect(hits).toHaveLength(1);
    expect(hits[0]?.entity).toBe("vendor");
  });

  it("returns an empty list when nothing matches", async () => {
    const schema = buildTestSchema(service);
    const result = await graphql({
      schema,
      source: `{ search(q: "nothing") { recordId } }`,
      contextValue: { tenantId: "t1" },
    });

    expect(result.errors).toBeUndefined();
    expect(result.data?.search).toEqual([]);
  });

  it("respects the limit argument", async () => {
    for (let i = 0; i < 5; i++) {
      await service.upsertDocument({
        tenantId: "t1",
        entity: "doc",
        recordId: `r${i}`,
        content: "alpha beta gamma",
      });
    }

    const schema = buildTestSchema(service);
    const result = await graphql({
      schema,
      source: `{ search(q: "alpha", limit: 3) { recordId } }`,
      contextValue: { tenantId: "t1" },
    });

    expect(result.errors).toBeUndefined();
    const hits = result.data?.search as Array<{ recordId: string }>;
    expect(hits).toHaveLength(3);
  });
});
