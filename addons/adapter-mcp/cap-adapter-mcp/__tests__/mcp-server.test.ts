import { describe, expect, mock, test } from "bun:test";
import type { ActionResult, CommandLayer } from "@linchkit/core";
import { defineAction, defineRule, defineEntity, defineState } from "@linchkit/core";
import { ActionRegistry, createEntityRegistry } from "@linchkit/core/server";
import { createMcpAdapter } from "../src/mcp-server";

const testSchema = defineEntity({
  name: "order",
  label: "Order",
  description: "Sales order",
  fields: {
    customer_name: { type: "string", label: "Customer", required: true },
    amount: { type: "number", label: "Amount", min: 0 },
    status: {
      type: "enum",
      label: "Status",
      options: [{ value: "draft" }, { value: "confirmed" }],
    },
  },
});

const testAction = defineAction({
  name: "create_order",
  schema: "order",
  label: "Create Order",
  description: "Creates a new sales order",
  input: {
    customer_name: { type: "string", required: true },
    amount: { type: "number", min: 0 },
  },
  policy: { mode: "sync", transaction: false },
  exposure: "all",
});

const hiddenAction = defineAction({
  name: "internal_cleanup",
  schema: "order",
  label: "Internal Cleanup",
  policy: { mode: "sync", transaction: false },
  exposure: { mcp: false, internal: true },
});

interface RegisteredTool {
  handler: (
    args: Record<string, unknown>,
    extra: unknown,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

type ToolsMap = Record<string, RegisteredTool>;

function getTools(server: unknown): ToolsMap {
  return (server as { _registeredTools: ToolsMap })._registeredTools;
}

function getResources(server: unknown): Record<string, unknown> {
  return (server as { _registeredResources: Record<string, unknown> })._registeredResources;
}

function createMockCommandLayer(): CommandLayer {
  const executeFn = mock(async (options: Record<string, unknown>) => {
    return {
      success: true,
      data: { id: "test-123", ...(options.input as Record<string, unknown>) },
      executionId: "exec-001",
    } as ActionResult;
  });

  return {
    execute: executeFn,
  } as unknown as CommandLayer;
}

describe("createMcpAdapter", () => {
  test("creates an MCP server with registered tools", async () => {
    const entityRegistry = createEntityRegistry();
    entityRegistry.register(testSchema);

    const actionRegistry = new ActionRegistry();
    actionRegistry.register(testAction);

    const commandLayer = createMockCommandLayer();

    const { server } = await createMcpAdapter({
      commandLayer,
      entityRegistry,
      actionRegistry,
    });

    expect(server).toBeDefined();
    const tools = getTools(server);
    expect(tools.create_order).toBeDefined();
    expect(tools.list_schemas).toBeDefined();
    expect(tools.get_schema).toBeDefined();
    expect(tools.list_actions).toBeDefined();
  });

  test("does not register actions with mcp exposure disabled", async () => {
    const entityRegistry = createEntityRegistry();
    entityRegistry.register(testSchema);

    const actionRegistry = new ActionRegistry();
    actionRegistry.register(testAction);
    actionRegistry.register(hiddenAction);

    const commandLayer = createMockCommandLayer();

    const { server } = await createMcpAdapter({
      commandLayer,
      entityRegistry,
      actionRegistry,
    });

    const tools = getTools(server);
    expect(tools.create_order).toBeDefined();
    expect(tools.internal_cleanup).toBeUndefined();
  });

  test("registered action tool handler calls commandLayer.execute with correct args", async () => {
    const entityRegistry = createEntityRegistry();
    entityRegistry.register(testSchema);

    const actionRegistry = new ActionRegistry();
    actionRegistry.register(testAction);

    const commandLayer = createMockCommandLayer();

    const { server } = await createMcpAdapter({
      commandLayer,
      entityRegistry,
      actionRegistry,
    });

    const tools = getTools(server);
    const result = await tools.create_order?.handler(
      { customer_name: "Acme Corp", amount: 100 },
      {},
    );

    // Verify commandLayer.execute was called
    expect(commandLayer.execute).toHaveBeenCalledTimes(1);

    const callArgs = (commandLayer.execute as ReturnType<typeof mock>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(callArgs.command).toBe("create_order");
    expect(callArgs.channel).toBe("mcp");
    expect((callArgs.input as Record<string, unknown>).customer_name).toBe("Acme Corp");
    expect((callArgs.actor as Record<string, unknown>).type).toBe("ai");
    expect((callArgs.actor as Record<string, unknown>).id).toBe("mcp-client");

    // Verify return format
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe("text");
    const parsed = JSON.parse(result.content[0]?.text);
    expect(parsed.success).toBe(true);
    expect(parsed.data.id).toBe("test-123");
  });

  test("list_schemas tool returns schema summaries", async () => {
    const entityRegistry = createEntityRegistry();
    entityRegistry.register(testSchema);

    const actionRegistry = new ActionRegistry();
    const commandLayer = createMockCommandLayer();

    const { server } = await createMcpAdapter({
      commandLayer,
      entityRegistry,
      actionRegistry,
    });

    const tools = getTools(server);
    const result = await tools.list_schemas?.handler({}, {});

    const parsed = JSON.parse(result.content[0]?.text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("order");
    expect(parsed[0].label).toBe("Order");
  });

  test("get_schema tool returns schema definition", async () => {
    const entityRegistry = createEntityRegistry();
    entityRegistry.register(testSchema);

    const actionRegistry = new ActionRegistry();
    const commandLayer = createMockCommandLayer();

    const { server } = await createMcpAdapter({
      commandLayer,
      entityRegistry,
      actionRegistry,
    });

    const tools = getTools(server);
    const result = await tools.get_schema?.handler({ name: "order" }, {});

    const parsed = JSON.parse(result.content[0]?.text);
    expect(parsed.name).toBe("order");
    expect(parsed.fields.properties).toHaveProperty("customer_name");
    expect(parsed.fields.properties).toHaveProperty("amount");
  });

  test("get_schema tool returns error for unknown schema", async () => {
    const entityRegistry = createEntityRegistry();
    const actionRegistry = new ActionRegistry();
    const commandLayer = createMockCommandLayer();

    const { server } = await createMcpAdapter({
      commandLayer,
      entityRegistry,
      actionRegistry,
    });

    const tools = getTools(server);
    const result = await tools.get_schema?.handler({ name: "nonexistent" }, {});

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]?.text);
    expect(parsed.error).toContain("not found");
  });

  test("list_actions tool returns action summaries", async () => {
    const entityRegistry = createEntityRegistry();
    entityRegistry.register(testSchema);

    const actionRegistry = new ActionRegistry();
    actionRegistry.register(testAction);

    const commandLayer = createMockCommandLayer();

    const { server } = await createMcpAdapter({
      commandLayer,
      entityRegistry,
      actionRegistry,
    });

    const tools = getTools(server);
    const result = await tools.list_actions?.handler({}, {});

    const parsed = JSON.parse(result.content[0]?.text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("create_order");
    expect(parsed[0].schema).toBe("order");
  });

  test("uses custom name and version", async () => {
    const entityRegistry = createEntityRegistry();
    const actionRegistry = new ActionRegistry();
    const commandLayer = createMockCommandLayer();

    const { server } = await createMcpAdapter({
      commandLayer,
      entityRegistry,
      actionRegistry,
      name: "my-app",
      version: "2.0.0",
    });

    expect(server).toBeDefined();
  });

  test("resources are registered", async () => {
    const entityRegistry = createEntityRegistry();
    entityRegistry.register(testSchema);

    const actionRegistry = new ActionRegistry();
    const commandLayer = createMockCommandLayer();

    const { server } = await createMcpAdapter({
      commandLayer,
      entityRegistry,
      actionRegistry,
    });

    const resources = getResources(server);
    expect(resources["linchkit://schemas"]).toBeDefined();
  });
});

describe("createMcpAdapter — bearer token auth", () => {
  test("authEnabled is false when no bearerToken is provided", async () => {
    const entityRegistry = createEntityRegistry();
    const actionRegistry = new ActionRegistry();
    const commandLayer = createMockCommandLayer();

    const { authEnabled, validateAuth } = await createMcpAdapter({
      commandLayer,
      entityRegistry,
      actionRegistry,
    });

    expect(authEnabled).toBe(false);
    // When no token is configured, any token (or none) passes
    expect(validateAuth(undefined)).toBe(true);
    expect(validateAuth("anything")).toBe(true);
  });

  test("authEnabled is false when bearerToken is empty string", async () => {
    const entityRegistry = createEntityRegistry();
    const actionRegistry = new ActionRegistry();
    const commandLayer = createMockCommandLayer();

    const { authEnabled, validateAuth } = await createMcpAdapter({
      commandLayer,
      entityRegistry,
      actionRegistry,
      bearerToken: "",
    });

    expect(authEnabled).toBe(false);
    expect(validateAuth(undefined)).toBe(true);
  });

  test("authEnabled is true when bearerToken is provided", async () => {
    const entityRegistry = createEntityRegistry();
    const actionRegistry = new ActionRegistry();
    const commandLayer = createMockCommandLayer();

    const { authEnabled } = await createMcpAdapter({
      commandLayer,
      entityRegistry,
      actionRegistry,
      bearerToken: "my-secret-token",
    });

    expect(authEnabled).toBe(true);
  });

  test("validateAuth rejects missing token when auth is enabled", async () => {
    const entityRegistry = createEntityRegistry();
    const actionRegistry = new ActionRegistry();
    const commandLayer = createMockCommandLayer();

    const { validateAuth } = await createMcpAdapter({
      commandLayer,
      entityRegistry,
      actionRegistry,
      bearerToken: "my-secret-token",
    });

    expect(validateAuth(undefined)).toBe(false);
  });

  test("validateAuth rejects wrong token when auth is enabled", async () => {
    const entityRegistry = createEntityRegistry();
    const actionRegistry = new ActionRegistry();
    const commandLayer = createMockCommandLayer();

    const { validateAuth } = await createMcpAdapter({
      commandLayer,
      entityRegistry,
      actionRegistry,
      bearerToken: "my-secret-token",
    });

    expect(validateAuth("wrong-token")).toBe(false);
  });

  test("validateAuth accepts correct token when auth is enabled", async () => {
    const entityRegistry = createEntityRegistry();
    const actionRegistry = new ActionRegistry();
    const commandLayer = createMockCommandLayer();

    const { validateAuth } = await createMcpAdapter({
      commandLayer,
      entityRegistry,
      actionRegistry,
      bearerToken: "my-secret-token",
    });

    expect(validateAuth("my-secret-token")).toBe(true);
  });
});

describe("createMcpAdapter — query proxy security", () => {
  test("query tool blocks GraphQL mutations", async () => {
    const entityRegistry = createEntityRegistry();
    const actionRegistry = new ActionRegistry();
    const commandLayer = createMockCommandLayer();

    const { server } = await createMcpAdapter({
      commandLayer,
      entityRegistry,
      actionRegistry,
      graphqlEndpoint: "http://localhost:3001/graphql",
    });

    const tools = getTools(server);
    const result = await tools.query?.handler(
      { query: "mutation { createOrder(input: {}) { id } }" },
      {},
    );

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]?.text);
    expect(parsed.error).toContain("Mutations and subscriptions are not allowed");
  });

  test("query tool blocks GraphQL subscriptions", async () => {
    const entityRegistry = createEntityRegistry();
    const actionRegistry = new ActionRegistry();
    const commandLayer = createMockCommandLayer();

    const { server } = await createMcpAdapter({
      commandLayer,
      entityRegistry,
      actionRegistry,
      graphqlEndpoint: "http://localhost:3001/graphql",
    });

    const tools = getTools(server);
    const result = await tools.query?.handler(
      { query: "subscription { orderCreated { id } }" },
      {},
    );

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]?.text);
    expect(parsed.error).toContain("Mutations and subscriptions are not allowed");
  });

  test("query tool blocks mutations preceded by fragment definitions", async () => {
    const entityRegistry = createEntityRegistry();
    const actionRegistry = new ActionRegistry();
    const commandLayer = createMockCommandLayer();

    const { server } = await createMcpAdapter({
      commandLayer,
      entityRegistry,
      actionRegistry,
      graphqlEndpoint: "http://localhost:3001/graphql",
    });

    const tools = getTools(server);
    const result = await tools.query?.handler(
      {
        query: "fragment Foo on Order { id } mutation { createOrder(input: {}) { id } }",
      },
      {},
    );

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]?.text);
    expect(parsed.error).toContain("Mutations and subscriptions are not allowed");
  });

  test("query tool blocks mutations preceded by comments", async () => {
    const entityRegistry = createEntityRegistry();
    const actionRegistry = new ActionRegistry();
    const commandLayer = createMockCommandLayer();

    const { server } = await createMcpAdapter({
      commandLayer,
      entityRegistry,
      actionRegistry,
      graphqlEndpoint: "http://localhost:3001/graphql",
    });

    const tools = getTools(server);
    const result = await tools.query?.handler(
      {
        query: '# This is a comment\nmutation { deleteOrder(id: "1") { id } }',
      },
      {},
    );

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]?.text);
    expect(parsed.error).toContain("Mutations and subscriptions are not allowed");
  });

  test("query tool blocks named mutations", async () => {
    const entityRegistry = createEntityRegistry();
    const actionRegistry = new ActionRegistry();
    const commandLayer = createMockCommandLayer();

    const { server } = await createMcpAdapter({
      commandLayer,
      entityRegistry,
      actionRegistry,
      graphqlEndpoint: "http://localhost:3001/graphql",
    });

    const tools = getTools(server);
    const result = await tools.query?.handler(
      {
        query: "mutation CreateOrder($input: OrderInput!) { createOrder(input: $input) { id } }",
      },
      {},
    );

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]?.text);
    expect(parsed.error).toContain("Mutations and subscriptions are not allowed");
  });

  test("query tool blocks subscriptions preceded by fragments", async () => {
    const entityRegistry = createEntityRegistry();
    const actionRegistry = new ActionRegistry();
    const commandLayer = createMockCommandLayer();

    const { server } = await createMcpAdapter({
      commandLayer,
      entityRegistry,
      actionRegistry,
      graphqlEndpoint: "http://localhost:3001/graphql",
    });

    const tools = getTools(server);
    const result = await tools.query?.handler(
      {
        query: "fragment F on X { id name } subscription { orderCreated { ...F } }",
      },
      {},
    );

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]?.text);
    expect(parsed.error).toContain("Mutations and subscriptions are not allowed");
  });

  test("query tool forwards malformed GraphQL to endpoint and returns error", async () => {
    const entityRegistry = createEntityRegistry();
    const actionRegistry = new ActionRegistry();
    const commandLayer = createMockCommandLayer();

    // Mock global fetch to simulate a GraphQL error response for malformed queries
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ errors: [{ message: "Syntax Error: Expected Name, found \"{\"" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    try {
      const { server } = await createMcpAdapter({
        commandLayer,
        entityRegistry,
        actionRegistry,
        graphqlEndpoint: "http://localhost:3001/graphql",
      });

      const tools = getTools(server);
      const result = await tools.query?.handler(
        { query: "this is not valid graphql at all {{{" },
        {},
      );

      // The query proxy forwards to the GraphQL endpoint; malformed queries
      // are caught by the GraphQL server, not the proxy itself
      const parsed = JSON.parse(result.content[0]?.text);
      expect(parsed.errors).toBeDefined();
      expect(parsed.errors[0].message).toContain("Syntax Error");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("query tool returns error when graphqlEndpoint is not configured", async () => {
    const entityRegistry = createEntityRegistry();
    const actionRegistry = new ActionRegistry();
    const commandLayer = createMockCommandLayer();

    const { server } = await createMcpAdapter({
      commandLayer,
      entityRegistry,
      actionRegistry,
      // no graphqlEndpoint
    });

    const tools = getTools(server);
    const result = await tools.query?.handler({ query: "{ orders { id } }" }, {});

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]?.text);
    expect(parsed.error).toContain("GraphQL endpoint not configured");
  });

  test("query tool allows regular queries when graphqlEndpoint is configured", async () => {
    const entityRegistry = createEntityRegistry();
    const actionRegistry = new ActionRegistry();
    const commandLayer = createMockCommandLayer();

    // Mock global fetch to simulate a successful GraphQL response
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ data: { orders: [{ id: "1" }] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    try {
      const { server } = await createMcpAdapter({
        commandLayer,
        entityRegistry,
        actionRegistry,
        graphqlEndpoint: "http://localhost:3001/graphql",
      });

      const tools = getTools(server);
      const result = await tools.query?.handler({ query: "{ orders { id } }" }, {});

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0]?.text);
      expect(parsed.data.orders).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("query tool forwards x-tenant-id header when tenantId is configured", async () => {
    const entityRegistry = createEntityRegistry();
    const actionRegistry = new ActionRegistry();
    const commandLayer = createMockCommandLayer();

    const originalFetch = globalThis.fetch;
    const mockFetchFn = mock(
      async () =>
        new Response(JSON.stringify({ data: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    globalThis.fetch = mockFetchFn;

    try {
      const { server } = await createMcpAdapter({
        commandLayer,
        entityRegistry,
        actionRegistry,
        graphqlEndpoint: "http://localhost:3001/graphql",
        tenantId: "tenant-42",
      });

      const tools = getTools(server);
      await tools.query?.handler({ query: "{ orders { id } }" }, {});

      // Verify fetch was called with x-tenant-id header
      expect(mockFetchFn).toHaveBeenCalledTimes(1);
      const callArgs = mockFetchFn.mock.calls[0] as [string, RequestInit];
      const headers = callArgs[1]?.headers as Record<string, string>;
      expect(headers["x-tenant-id"]).toBe("tenant-42");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("createMcpAdapter — list_actions exposure filter", () => {
  test("list_actions excludes actions with exposure.mcp set to false", async () => {
    const entityRegistry = createEntityRegistry();
    entityRegistry.register(testSchema);

    const actionRegistry = new ActionRegistry();
    actionRegistry.register(testAction);
    actionRegistry.register(hiddenAction);

    const commandLayer = createMockCommandLayer();

    const { server } = await createMcpAdapter({
      commandLayer,
      entityRegistry,
      actionRegistry,
    });

    const tools = getTools(server);
    const result = await tools.list_actions?.handler({}, {});

    const parsed = JSON.parse(result.content[0]?.text);
    // Only create_order should be listed; internal_cleanup has mcp: false
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("create_order");
    expect(parsed.find((a: { name: string }) => a.name === "internal_cleanup")).toBeUndefined();
  });

  test("list_actions includes actions with exposure 'all'", async () => {
    const entityRegistry = createEntityRegistry();
    entityRegistry.register(testSchema);

    const actionRegistry = new ActionRegistry();
    actionRegistry.register(testAction); // exposure: "all"

    const commandLayer = createMockCommandLayer();

    const { server } = await createMcpAdapter({
      commandLayer,
      entityRegistry,
      actionRegistry,
    });

    const tools = getTools(server);
    const result = await tools.list_actions?.handler({}, {});

    const parsed = JSON.parse(result.content[0]?.text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("create_order");
  });
});

describe("createMcpAdapter — tenantId option", () => {
  test("tenantId option is accepted in McpAdapterOptions", async () => {
    const entityRegistry = createEntityRegistry();
    const actionRegistry = new ActionRegistry();
    const commandLayer = createMockCommandLayer();

    // Should not throw — tenantId is a valid option
    const { server } = await createMcpAdapter({
      commandLayer,
      entityRegistry,
      actionRegistry,
      tenantId: "tenant-99",
    });

    expect(server).toBeDefined();
  });
});

// ── Additional test fixtures for introspection tools ──────────────────

const productSchema = defineEntity({
  name: "product",
  label: "Product",
  description: "Product catalog",
  fields: {
    title: { type: "string", label: "Title", required: true },
    price: { type: "number", label: "Price", min: 0 },
    status: { type: "state", label: "Status", machine: "product_lifecycle" },
  },
  presentation: {
    titleField: "title",
    badgeField: "status",
    summaryFields: ["price"],
    icon: "package",
  },
});

const createProductAction = defineAction({
  name: "create_product",
  schema: "product",
  label: "Create Product",
  description: "Creates a new product",
  input: {
    title: { type: "string", required: true },
    price: { type: "number", min: 0 },
  },
  policy: { mode: "sync", transaction: false },
  exposure: "all",
});

const testRule = defineRule({
  name: "high_value_approval",
  label: "High Value Approval",
  description: "Orders above 10000 require approval",
  trigger: { action: "create_order" },
  condition: { field: "amount", operator: "gt", value: 10000 },
  effect: { type: "require_approval", level: "manager", message: "High value order" },
  priority: 10,
});

const productRule = defineRule({
  name: "product_price_check",
  label: "Product Price Check",
  description: "Product price must be positive",
  trigger: { fieldChange: { schema: "product", field: "price" } },
  condition: { field: "price", operator: "lte", value: 0 },
  effect: { type: "block", message: "Price must be positive" },
});

const testStateMachine = defineState({
  name: "order_status",
  schema: "order",
  field: "status",
  initial: "draft",
  states: ["draft", "confirmed", "shipped", "delivered"],
  transitions: [
    { from: "draft", to: "confirmed", action: "confirm_order" },
    { from: "confirmed", to: "shipped", action: "ship_order" },
    { from: "shipped", to: "delivered", action: "deliver_order" },
  ],
  meta: {
    draft: { label: "Draft", color: "gray" },
    confirmed: { label: "Confirmed", color: "blue" },
    shipped: { label: "Shipped", color: "orange" },
    delivered: { label: "Delivered", color: "green" },
  },
});

const productStateMachine = defineState({
  name: "product_lifecycle",
  schema: "product",
  field: "status",
  initial: "draft",
  states: ["draft", "active", "archived"],
  transitions: [
    { from: "draft", to: "active", action: "publish_product" },
    { from: "active", to: "archived", action: "archive_product" },
  ],
});

describe("createMcpAdapter — list_actions with schema filter", () => {
  test("list_actions returns all actions when no schema filter", async () => {
    const entityRegistry = createEntityRegistry();
    entityRegistry.register(testSchema);
    entityRegistry.register(productSchema);

    const actionRegistry = new ActionRegistry();
    actionRegistry.register(testAction);
    actionRegistry.register(createProductAction);

    const commandLayer = createMockCommandLayer();

    const { server } = await createMcpAdapter({
      commandLayer,
      entityRegistry,
      actionRegistry,
    });

    const tools = getTools(server);
    const result = await tools.list_actions?.handler({}, {});

    const parsed = JSON.parse(result.content[0]?.text);
    expect(parsed).toHaveLength(2);
  });

  test("list_actions returns all actions including schema info", async () => {
    const entityRegistry = createEntityRegistry();
    entityRegistry.register(testSchema);
    entityRegistry.register(productSchema);

    const actionRegistry = new ActionRegistry();
    actionRegistry.register(testAction);
    actionRegistry.register(createProductAction);

    const commandLayer = createMockCommandLayer();

    const { server } = await createMcpAdapter({
      commandLayer,
      entityRegistry,
      actionRegistry,
    });

    const tools = getTools(server);
    const result = await tools.list_actions?.handler({}, {});

    const parsed = JSON.parse(result.content[0]?.text);
    expect(parsed).toHaveLength(2);
    const productAction = parsed.find((a: { name: string }) => a.name === "create_product");
    expect(productAction).toBeDefined();
    expect(productAction.schema).toBe("product");
  });

  test("list_actions returns empty array when no actions registered", async () => {
    const entityRegistry = createEntityRegistry();
    const actionRegistry = new ActionRegistry();

    const commandLayer = createMockCommandLayer();

    const { server } = await createMcpAdapter({
      commandLayer,
      entityRegistry,
      actionRegistry,
    });

    const tools = getTools(server);
    const result = await tools.list_actions?.handler({}, {});

    const parsed = JSON.parse(result.content[0]?.text);
    expect(parsed).toHaveLength(0);
  });
});

describe("createMcpAdapter — get_schema (detailed)", () => {
  test("get_schema returns full schema details with fields", async () => {
    const entityRegistry = createEntityRegistry();
    entityRegistry.register(productSchema);

    const actionRegistry = new ActionRegistry();
    actionRegistry.register(createProductAction);

    const commandLayer = createMockCommandLayer();

    const { server } = await createMcpAdapter({
      commandLayer,
      entityRegistry,
      actionRegistry,
      rules: [productRule],
      states: [productStateMachine],
    });

    const tools = getTools(server);
    const result = await tools.get_schema?.handler({ name: "product" }, {});

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]?.text);

    // Basic info
    expect(parsed.name).toBe("product");
    expect(parsed.label).toBe("Product");
    expect(parsed.description).toBe("Product catalog");

    // Fields
    expect(parsed.fields.properties).toHaveProperty("title");
    expect(parsed.fields.properties).toHaveProperty("price");
  });

  test("get_schema returns error for unknown schema", async () => {
    const entityRegistry = createEntityRegistry();
    const actionRegistry = new ActionRegistry();
    const commandLayer = createMockCommandLayer();

    const { server } = await createMcpAdapter({
      commandLayer,
      entityRegistry,
      actionRegistry,
    });

    const tools = getTools(server);
    const result = await tools.get_schema?.handler({ name: "nonexistent" }, {});

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]?.text);
    expect(parsed.error).toContain("not found");
  });

  test("get_schema returns schema without presentation field", async () => {
    const entityRegistry = createEntityRegistry();
    entityRegistry.register(testSchema); // testSchema has no presentation

    const actionRegistry = new ActionRegistry();
    const commandLayer = createMockCommandLayer();

    const { server } = await createMcpAdapter({
      commandLayer,
      entityRegistry,
      actionRegistry,
    });

    const tools = getTools(server);
    const result = await tools.get_schema?.handler({ name: "order" }, {});

    const parsed = JSON.parse(result.content[0]?.text);
    expect(parsed.name).toBe("order");
    expect(parsed.fields).toBeDefined();
    expect(parsed.fields.properties).toHaveProperty("customer_name");
  });

  test("get_schema returns fields with correct JSON schema types", async () => {
    const entityRegistry = createEntityRegistry();
    entityRegistry.register(testSchema);

    const actionRegistry = new ActionRegistry();
    actionRegistry.register(testAction);

    const commandLayer = createMockCommandLayer();

    const { server } = await createMcpAdapter({
      commandLayer,
      entityRegistry,
      actionRegistry,
      rules: [testRule, productRule],
      states: [testStateMachine],
    });

    const tools = getTools(server);
    const result = await tools.get_schema?.handler({ name: "order" }, {});

    const parsed = JSON.parse(result.content[0]?.text);
    expect(parsed.name).toBe("order");
    expect(parsed.fields.properties).toHaveProperty("customer_name");
    expect(parsed.fields.properties).toHaveProperty("amount");
  });
});

describe("createMcpAdapter — get_rules", () => {
  test("get_rules returns all rules when no filter", async () => {
    const entityRegistry = createEntityRegistry();
    const actionRegistry = new ActionRegistry();
    const commandLayer = createMockCommandLayer();

    const { server } = await createMcpAdapter({
      commandLayer,
      entityRegistry,
      actionRegistry,
      rules: [testRule, productRule],
    });

    const tools = getTools(server);
    const result = await tools.get_rules?.handler({}, {});

    const parsed = JSON.parse(result.content[0]?.text);
    expect(parsed).toHaveLength(2);
  });

  test("get_rules filters by schema name (fieldChange trigger)", async () => {
    const entityRegistry = createEntityRegistry();
    const actionRegistry = new ActionRegistry();
    const commandLayer = createMockCommandLayer();

    const { server } = await createMcpAdapter({
      commandLayer,
      entityRegistry,
      actionRegistry,
      rules: [testRule, productRule],
    });

    const tools = getTools(server);
    const result = await tools.get_rules?.handler({ schema: "product" }, {});

    const parsed = JSON.parse(result.content[0]?.text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("product_price_check");
  });

  test("get_rules filters by action name", async () => {
    const entityRegistry = createEntityRegistry();
    const actionRegistry = new ActionRegistry();
    const commandLayer = createMockCommandLayer();

    const { server } = await createMcpAdapter({
      commandLayer,
      entityRegistry,
      actionRegistry,
      rules: [testRule, productRule],
    });

    const tools = getTools(server);
    const result = await tools.get_rules?.handler({ action: "create_order" }, {});

    const parsed = JSON.parse(result.content[0]?.text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("high_value_approval");
  });

  test("get_rules returns empty array when no matching rules", async () => {
    const entityRegistry = createEntityRegistry();
    const actionRegistry = new ActionRegistry();
    const commandLayer = createMockCommandLayer();

    const { server } = await createMcpAdapter({
      commandLayer,
      entityRegistry,
      actionRegistry,
      rules: [testRule],
    });

    const tools = getTools(server);
    const result = await tools.get_rules?.handler({ schema: "nonexistent" }, {});

    const parsed = JSON.parse(result.content[0]?.text);
    expect(parsed).toHaveLength(0);
  });
});

describe("createMcpAdapter — get_state_machine", () => {
  test("get_state_machine returns state machine for schema", async () => {
    const entityRegistry = createEntityRegistry();
    const actionRegistry = new ActionRegistry();
    const commandLayer = createMockCommandLayer();

    const { server } = await createMcpAdapter({
      commandLayer,
      entityRegistry,
      actionRegistry,
      states: [testStateMachine, productStateMachine],
    });

    const tools = getTools(server);
    const result = await tools.get_state_machine?.handler({ schema: "order" }, {});

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0]?.text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("order_status");
    expect(parsed[0].field).toBe("status");
    expect(parsed[0].initial).toBe("draft");
    expect(parsed[0].states).toEqual(["draft", "confirmed", "shipped", "delivered"]);
    expect(parsed[0].transitions).toHaveLength(3);
    expect(parsed[0].meta).toBeDefined();
    expect(parsed[0].meta.draft.label).toBe("Draft");
    expect(parsed[0].meta.draft.color).toBe("gray");
  });

  test("get_state_machine returns error for schema with no state machine", async () => {
    const entityRegistry = createEntityRegistry();
    const actionRegistry = new ActionRegistry();
    const commandLayer = createMockCommandLayer();

    const { server } = await createMcpAdapter({
      commandLayer,
      entityRegistry,
      actionRegistry,
      states: [testStateMachine],
    });

    const tools = getTools(server);
    const result = await tools.get_state_machine?.handler({ schema: "nonexistent" }, {});

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]?.text);
    expect(parsed.error).toContain("No state machine found");
  });

  test("introspection tools are registered", async () => {
    const entityRegistry = createEntityRegistry();
    const actionRegistry = new ActionRegistry();
    const commandLayer = createMockCommandLayer();

    const { server } = await createMcpAdapter({
      commandLayer,
      entityRegistry,
      actionRegistry,
    });

    const tools = getTools(server);
    expect(tools.get_schema).toBeDefined();
    expect(tools.get_rules).toBeDefined();
    expect(tools.get_state_machine).toBeDefined();
  });
});
