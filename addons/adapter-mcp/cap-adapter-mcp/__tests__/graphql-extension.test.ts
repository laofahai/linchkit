/**
 * Tests for MCP Client Registry GraphQL extension
 *
 * Validates that buildMcpGraphQLExtension() produces correct query/mutation fields
 * and that resolvers interact with the registry properly.
 */

import { describe, expect, test } from "bun:test";
import { GraphQLObjectType, GraphQLSchema, graphql } from "graphql";
import { McpClientRegistry } from "../src/client-registry";
import { InMemoryMcpClientStore } from "../src/client-store-memory";
import { buildMcpGraphQLExtension } from "../src/graphql";

/** Build a minimal executable schema from the extension for testing */
function buildTestSchema() {
  const store = new InMemoryMcpClientStore();
  const registry = new McpClientRegistry(store);
  const ext = buildMcpGraphQLExtension({ registry });

  const queryType = new GraphQLObjectType({
    name: "Query",
    fields: ext.queryFields,
  });

  const mutationType = new GraphQLObjectType({
    name: "Mutation",
    fields: ext.mutationFields,
  });

  const schema = new GraphQLSchema({
    query: queryType,
    mutation: mutationType,
  });

  return { schema, registry, store };
}

describe("buildMcpGraphQLExtension", () => {
  test("returns queryFields and mutationFields", () => {
    const store = new InMemoryMcpClientStore();
    const registry = new McpClientRegistry(store);
    const ext = buildMcpGraphQLExtension({ registry });

    expect(ext.queryFields).toBeDefined();
    expect(ext.mutationFields).toBeDefined();

    // Query fields
    expect(ext.queryFields.mcpClients).toBeDefined();
    expect(ext.queryFields.mcpClient).toBeDefined();
    expect(ext.queryFields.mcpUsageStats).toBeDefined();

    // Mutation fields
    expect(ext.mutationFields.createMcpClient).toBeDefined();
    expect(ext.mutationFields.updateMcpClient).toBeDefined();
    expect(ext.mutationFields.deleteMcpClient).toBeDefined();
    expect(ext.mutationFields.rotateMcpClientSecret).toBeDefined();
    expect(ext.mutationFields.toggleMcpClient).toBeDefined();
  });
});

describe("Query resolvers", () => {
  test("mcpClients returns empty list initially", async () => {
    const { schema } = buildTestSchema();

    const result = await graphql({
      schema,
      source: `{ mcpClients { id name clientId enabled } }`,
    });

    expect(result.errors).toBeUndefined();
    expect(result.data?.mcpClients).toEqual([]);
  });

  test("mcpClients returns created clients", async () => {
    const { schema } = buildTestSchema();

    // Create a client first
    await graphql({
      schema,
      source: `mutation {
				createMcpClient(input: {
					name: "Test Agent"
					clientId: "agent-1"
				}) {
					clientId
					clientSecret
				}
			}`,
    });

    const result = await graphql({
      schema,
      source: `{ mcpClients { id name clientId enabled actorType } }`,
    });

    expect(result.errors).toBeUndefined();
    const clients = result.data?.mcpClients as Array<Record<string, unknown>>;
    expect(clients).toHaveLength(1);
    expect(clients[0].name).toBe("Test Agent");
    expect(clients[0].clientId).toBe("agent-1");
    expect(clients[0].enabled).toBe(true);
    expect(clients[0].actorType).toBe("ai");
  });

  test("mcpClients filters by enabled status", async () => {
    const { schema } = buildTestSchema();

    // Create two clients
    const create1 = await graphql({
      schema,
      source: `mutation {
				createMcpClient(input: { name: "Active", clientId: "active-1" }) {
					clientId
				}
			}`,
    });
    expect(create1.errors).toBeUndefined();

    const create2 = await graphql({
      schema,
      source: `mutation {
				createMcpClient(input: { name: "Inactive", clientId: "inactive-1" }) {
					clientId
				}
			}`,
    });
    expect(create2.errors).toBeUndefined();

    // Get all to find the second client's ID
    const allResult = await graphql({
      schema,
      source: `{ mcpClients { id name clientId } }`,
    });
    const allClients = allResult.data?.mcpClients as Array<Record<string, unknown>>;
    const inactiveId = allClients.find((c) => c.name === "Inactive")?.id;

    // Disable the second client
    await graphql({
      schema,
      source: `mutation($id: ID!) {
				toggleMcpClient(id: $id, enabled: false) { id enabled }
			}`,
      variableValues: { id: inactiveId },
    });

    // Filter enabled only
    const enabledResult = await graphql({
      schema,
      source: `{ mcpClients(enabled: true) { name } }`,
    });
    expect(enabledResult.errors).toBeUndefined();
    const enabledClients = enabledResult.data?.mcpClients as Array<Record<string, unknown>>;
    expect(enabledClients).toHaveLength(1);
    expect(enabledClients[0].name).toBe("Active");
  });

  test("mcpClient returns single client by ID", async () => {
    const { schema } = buildTestSchema();

    // Create a client
    await graphql({
      schema,
      source: `mutation {
				createMcpClient(input: { name: "Lookup", clientId: "lookup-1" }) {
					clientId
				}
			}`,
    });

    // Get the ID
    const listResult = await graphql({
      schema,
      source: `{ mcpClients { id } }`,
    });
    const id = (listResult.data?.mcpClients as Array<Record<string, unknown>>)[0].id;

    // Fetch by ID
    const result = await graphql({
      schema,
      source: `query($id: ID!) { mcpClient(id: $id) { id name clientId } }`,
      variableValues: { id },
    });

    expect(result.errors).toBeUndefined();
    const client = result.data?.mcpClient as Record<string, unknown>;
    expect(client.name).toBe("Lookup");
    expect(client.clientId).toBe("lookup-1");
  });

  test("mcpClient returns null for non-existent ID", async () => {
    const { schema } = buildTestSchema();

    const result = await graphql({
      schema,
      source: `{ mcpClient(id: "non-existent") { id } }`,
    });

    expect(result.errors).toBeUndefined();
    expect(result.data?.mcpClient).toBeNull();
  });

  test("mcpUsageStats returns stub data", async () => {
    const { schema } = buildTestSchema();

    // Create client
    await graphql({
      schema,
      source: `mutation {
				createMcpClient(input: { name: "Stats", clientId: "stats-1" }) { clientId }
			}`,
    });

    const listResult = await graphql({
      schema,
      source: `{ mcpClients { id } }`,
    });
    const id = (listResult.data?.mcpClients as Array<Record<string, unknown>>)[0].id;

    const result = await graphql({
      schema,
      source: `query($id: ID!) {
				mcpUsageStats(id: $id) {
					clientId totalRequests last24h last7d topTools { toolName count }
				}
			}`,
      variableValues: { id },
    });

    expect(result.errors).toBeUndefined();
    const stats = result.data?.mcpUsageStats as Record<string, unknown>;
    expect(stats.clientId).toBe("stats-1");
    expect(stats.totalRequests).toBe(0);
    expect(stats.last24h).toBe(0);
    expect(stats.last7d).toBe(0);
    expect(stats.topTools).toEqual([]);
  });
});

describe("Mutation resolvers", () => {
  test("createMcpClient returns credentials with clientSecret", async () => {
    const { schema } = buildTestSchema();

    const result = await graphql({
      schema,
      source: `mutation {
				createMcpClient(input: {
					name: "New Agent"
					clientId: "new-agent-1"
					description: "A test agent"
					actorType: ai
					actorGroups: ["ai_agent", "admin"]
				}) {
					clientId
					clientSecret
				}
			}`,
    });

    expect(result.errors).toBeUndefined();
    const creds = result.data?.createMcpClient as Record<string, unknown>;
    expect(creds.clientId).toBe("new-agent-1");
    expect(creds.clientSecret).toBeDefined();
    expect(typeof creds.clientSecret).toBe("string");
    expect((creds.clientSecret as string).startsWith("mcp_")).toBe(true);
  });

  test("updateMcpClient modifies client fields", async () => {
    const { schema } = buildTestSchema();

    // Create
    await graphql({
      schema,
      source: `mutation {
				createMcpClient(input: { name: "Original", clientId: "upd-1" }) {
					clientId
				}
			}`,
    });

    const listResult = await graphql({
      schema,
      source: `{ mcpClients { id } }`,
    });
    const id = (listResult.data?.mcpClients as Array<Record<string, unknown>>)[0].id;

    // Update
    const result = await graphql({
      schema,
      source: `mutation($id: ID!) {
				updateMcpClient(id: $id, input: {
					name: "Updated"
					description: "New description"
				}) {
					id name description
				}
			}`,
      variableValues: { id },
    });

    expect(result.errors).toBeUndefined();
    const updated = result.data?.updateMcpClient as Record<string, unknown>;
    expect(updated.name).toBe("Updated");
    expect(updated.description).toBe("New description");
  });

  test("deleteMcpClient removes the client", async () => {
    const { schema } = buildTestSchema();

    // Create
    await graphql({
      schema,
      source: `mutation {
				createMcpClient(input: { name: "ToDelete", clientId: "del-1" }) { clientId }
			}`,
    });

    const listResult = await graphql({
      schema,
      source: `{ mcpClients { id } }`,
    });
    const id = (listResult.data?.mcpClients as Array<Record<string, unknown>>)[0].id;

    // Delete
    const deleteResult = await graphql({
      schema,
      source: `mutation($id: ID!) { deleteMcpClient(id: $id) }`,
      variableValues: { id },
    });

    expect(deleteResult.errors).toBeUndefined();
    expect(deleteResult.data?.deleteMcpClient).toBe(true);

    // Verify deleted
    const afterResult = await graphql({
      schema,
      source: `{ mcpClients { id } }`,
    });
    expect((afterResult.data?.mcpClients as unknown[]).length).toBe(0);
  });

  test("rotateMcpClientSecret returns new credentials", async () => {
    const { schema } = buildTestSchema();

    // Create
    const createResult = await graphql({
      schema,
      source: `mutation {
				createMcpClient(input: { name: "Rotate", clientId: "rot-1" }) {
					clientId
					clientSecret
				}
			}`,
    });
    const originalSecret = (createResult.data?.createMcpClient as Record<string, unknown>)
      .clientSecret;

    const listResult = await graphql({
      schema,
      source: `{ mcpClients { id } }`,
    });
    const id = (listResult.data?.mcpClients as Array<Record<string, unknown>>)[0].id;

    // Rotate
    const rotateResult = await graphql({
      schema,
      source: `mutation($id: ID!) {
				rotateMcpClientSecret(id: $id) { clientId clientSecret }
			}`,
      variableValues: { id },
    });

    expect(rotateResult.errors).toBeUndefined();
    const newCreds = rotateResult.data?.rotateMcpClientSecret as Record<string, unknown>;
    expect(newCreds.clientId).toBe("rot-1");
    expect(newCreds.clientSecret).toBeDefined();
    expect(newCreds.clientSecret).not.toBe(originalSecret);
  });

  test("toggleMcpClient enables/disables client", async () => {
    const { schema } = buildTestSchema();

    // Create
    await graphql({
      schema,
      source: `mutation {
				createMcpClient(input: { name: "Toggle", clientId: "tog-1" }) { clientId }
			}`,
    });

    const listResult = await graphql({
      schema,
      source: `{ mcpClients { id enabled } }`,
    });
    const client = (listResult.data?.mcpClients as Array<Record<string, unknown>>)[0];
    expect(client.enabled).toBe(true);

    // Disable
    const disableResult = await graphql({
      schema,
      source: `mutation($id: ID!) {
				toggleMcpClient(id: $id, enabled: false) { id enabled }
			}`,
      variableValues: { id: client.id },
    });

    expect(disableResult.errors).toBeUndefined();
    const disabled = disableResult.data?.toggleMcpClient as Record<string, unknown>;
    expect(disabled.enabled).toBe(false);

    // Re-enable
    const enableResult = await graphql({
      schema,
      source: `mutation($id: ID!) {
				toggleMcpClient(id: $id, enabled: true) { id enabled }
			}`,
      variableValues: { id: client.id },
    });

    expect(enableResult.errors).toBeUndefined();
    const enabled = enableResult.data?.toggleMcpClient as Record<string, unknown>;
    expect(enabled.enabled).toBe(true);
  });
});

describe("Security: secretHash never exposed", () => {
  test("McpClient type does not include secretHash field", () => {
    const store = new InMemoryMcpClientStore();
    const registry = new McpClientRegistry(store);
    const ext = buildMcpGraphQLExtension({ registry });

    // Get the McpClient type from the query field return type
    const mcpClientField = ext.queryFields.mcpClient;
    const returnType = mcpClientField.type;

    // Introspect the type to verify secretHash is not present
    // The type is McpClientType (possibly wrapped in NonNull)
    const objectType =
      "ofType" in (returnType as { ofType?: unknown })
        ? ((returnType as { ofType: GraphQLObjectType }).ofType as GraphQLObjectType)
        : (returnType as GraphQLObjectType);

    const fields = objectType.getFields();
    expect(fields.secretHash).toBeUndefined();
  });

  test("GraphQL query cannot request secretHash", async () => {
    const { schema } = buildTestSchema();

    // Create a client
    await graphql({
      schema,
      source: `mutation {
				createMcpClient(input: { name: "Secret", clientId: "sec-1" }) { clientId }
			}`,
    });

    // Try to query secretHash -- should fail
    const result = await graphql({
      schema,
      source: `{ mcpClients { id secretHash } }`,
    });

    expect(result.errors).toBeDefined();
    expect(result.errors?.length).toBeGreaterThan(0);
    expect(result.errors?.[0].message).toContain("secretHash");
  });
});

describe("Date serialization", () => {
  test("createdAt and updatedAt are ISO strings", async () => {
    const { schema } = buildTestSchema();

    await graphql({
      schema,
      source: `mutation {
				createMcpClient(input: { name: "Dates", clientId: "date-1" }) { clientId }
			}`,
    });

    const result = await graphql({
      schema,
      source: `{ mcpClients { createdAt updatedAt } }`,
    });

    expect(result.errors).toBeUndefined();
    const client = (result.data?.mcpClients as Array<Record<string, unknown>>)[0];
    // Should be valid ISO date strings
    expect(new Date(client.createdAt as string).toISOString()).toBe(client.createdAt);
    expect(new Date(client.updatedAt as string).toISOString()).toBe(client.updatedAt);
  });
});
