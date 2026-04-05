import { describe, expect, test } from "bun:test";
import { GraphQLNonNull, GraphQLString, graphql } from "graphql";
import { buildGraphQLSchema } from "../src/graphql/build-schema";

describe("graphqlExtensions merge", () => {
  test("extra query fields are accessible in built schema", async () => {
    const schema = buildGraphQLSchema([], {
      extraQueryFields: {
        hello: {
          type: new GraphQLNonNull(GraphQLString),
          resolve: () => "world",
        },
      },
    });

    const result = await graphql({ schema, source: "{ hello }" });
    expect(result.errors).toBeUndefined();
    expect(result.data?.hello).toBe("world");
  });

  test("extra mutation fields are accessible in built schema", async () => {
    const schema = buildGraphQLSchema([], {
      extraMutationFields: {
        ping: {
          type: new GraphQLNonNull(GraphQLString),
          resolve: () => "pong",
        },
      },
    });

    const result = await graphql({
      schema,
      source: "mutation { ping }",
    });
    expect(result.errors).toBeUndefined();
    expect(result.data?.ping).toBe("pong");
  });

  test("extra fields coexist with CRUD fields", async () => {
    const schema = buildGraphQLSchema(
      [
        {
          name: "task",
          label: "Task",
          fields: {
            title: { type: "text", label: "Title", required: true },
          },
        },
      ],
      {
        extraQueryFields: {
          serverTime: {
            type: new GraphQLNonNull(GraphQLString),
            resolve: () => "2026-01-01T00:00:00Z",
          },
        },
      },
    );

    const result = await graphql({ schema, source: "{ serverTime }" });
    expect(result.errors).toBeUndefined();
    expect(result.data?.serverTime).toBe("2026-01-01T00:00:00Z");
  });
});
