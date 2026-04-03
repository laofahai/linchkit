import { describe, expect, test } from "bun:test";
import { GraphQLNonNull, GraphQLString } from "graphql";
import { defineCapability } from "@linchkit/core";

describe("CapabilityDefinition extensions", () => {
  test("accepts group field", () => {
    const cap = defineCapability({
      name: "test-cap",
      label: "Test",
      type: "standard",
      category: "business",
      version: "0.1.0",
      group: "test-group",
    });
    expect(cap.group).toBe("test-group");
  });

  test("accepts autoInstall field", () => {
    const cap = defineCapability({
      name: "test-ui",
      label: "Test UI",
      type: "standard",
      category: "system",
      version: "0.1.0",
      dependencies: ["cap-adapter-ui", "test-cap"],
      autoInstall: true,
    });
    expect(cap.autoInstall).toBe(true);
    expect(cap.dependencies).toEqual(["cap-adapter-ui", "test-cap"]);
  });

  test("autoInstall defaults to undefined (falsy)", () => {
    const cap = defineCapability({
      name: "test-cap",
      label: "Test",
      type: "standard",
      category: "business",
      version: "0.1.0",
    });
    expect(cap.autoInstall).toBeUndefined();
  });
});

describe("graphqlExtensions", () => {
  test("capability accepts graphqlExtensions with queryFields", () => {
    const cap = defineCapability({
      name: "test-gql",
      label: "Test GQL",
      type: "standard",
      category: "system",
      version: "0.1.0",
      extensions: {
        graphqlExtensions: {
          queryFields: {
            testQuery: {
              type: new GraphQLNonNull(GraphQLString),
              resolve: () => "hello",
            },
          },
        },
      },
    });
    expect(cap.extensions?.graphqlExtensions?.queryFields).toBeDefined();
    expect(cap.extensions?.graphqlExtensions?.queryFields?.testQuery).toBeDefined();
  });

  test("capability accepts graphqlExtensions with mutationFields", () => {
    const cap = defineCapability({
      name: "test-gql-mut",
      label: "Test GQL Mut",
      type: "standard",
      category: "system",
      version: "0.1.0",
      extensions: {
        graphqlExtensions: {
          mutationFields: {
            testMutation: {
              type: new GraphQLNonNull(GraphQLString),
              args: { input: { type: GraphQLString } },
              resolve: () => "done",
            },
          },
        },
      },
    });
    expect(cap.extensions?.graphqlExtensions?.mutationFields?.testMutation).toBeDefined();
  });
});
