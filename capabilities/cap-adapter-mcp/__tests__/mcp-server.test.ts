import { describe, expect, mock, test } from "bun:test";
import type { ActionResult, CommandLayer } from "@linchkit/core";
import { ActionRegistry, createSchemaRegistry, defineAction, defineSchema } from "@linchkit/core";
import { createMcpAdapter } from "../src/mcp-server";

const testSchema = defineSchema({
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
    const schemaRegistry = createSchemaRegistry();
    schemaRegistry.register(testSchema);

    const actionRegistry = new ActionRegistry();
    actionRegistry.register(testAction);

    const commandLayer = createMockCommandLayer();

    const { server } = await createMcpAdapter({
      commandLayer,
      schemaRegistry,
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
    const schemaRegistry = createSchemaRegistry();
    schemaRegistry.register(testSchema);

    const actionRegistry = new ActionRegistry();
    actionRegistry.register(testAction);
    actionRegistry.register(hiddenAction);

    const commandLayer = createMockCommandLayer();

    const { server } = await createMcpAdapter({
      commandLayer,
      schemaRegistry,
      actionRegistry,
    });

    const tools = getTools(server);
    expect(tools.create_order).toBeDefined();
    expect(tools.internal_cleanup).toBeUndefined();
  });

  test("registered action tool handler calls commandLayer.execute with correct args", async () => {
    const schemaRegistry = createSchemaRegistry();
    schemaRegistry.register(testSchema);

    const actionRegistry = new ActionRegistry();
    actionRegistry.register(testAction);

    const commandLayer = createMockCommandLayer();

    const { server } = await createMcpAdapter({
      commandLayer,
      schemaRegistry,
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
    const schemaRegistry = createSchemaRegistry();
    schemaRegistry.register(testSchema);

    const actionRegistry = new ActionRegistry();
    const commandLayer = createMockCommandLayer();

    const { server } = await createMcpAdapter({
      commandLayer,
      schemaRegistry,
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
    const schemaRegistry = createSchemaRegistry();
    schemaRegistry.register(testSchema);

    const actionRegistry = new ActionRegistry();
    const commandLayer = createMockCommandLayer();

    const { server } = await createMcpAdapter({
      commandLayer,
      schemaRegistry,
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
    const schemaRegistry = createSchemaRegistry();
    const actionRegistry = new ActionRegistry();
    const commandLayer = createMockCommandLayer();

    const { server } = await createMcpAdapter({
      commandLayer,
      schemaRegistry,
      actionRegistry,
    });

    const tools = getTools(server);
    const result = await tools.get_schema?.handler({ name: "nonexistent" }, {});

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0]?.text);
    expect(parsed.error).toContain("not found");
  });

  test("list_actions tool returns action summaries", async () => {
    const schemaRegistry = createSchemaRegistry();
    schemaRegistry.register(testSchema);

    const actionRegistry = new ActionRegistry();
    actionRegistry.register(testAction);

    const commandLayer = createMockCommandLayer();

    const { server } = await createMcpAdapter({
      commandLayer,
      schemaRegistry,
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
    const schemaRegistry = createSchemaRegistry();
    const actionRegistry = new ActionRegistry();
    const commandLayer = createMockCommandLayer();

    const { server } = await createMcpAdapter({
      commandLayer,
      schemaRegistry,
      actionRegistry,
      name: "my-app",
      version: "2.0.0",
    });

    expect(server).toBeDefined();
  });

  test("resources are registered", async () => {
    const schemaRegistry = createSchemaRegistry();
    schemaRegistry.register(testSchema);

    const actionRegistry = new ActionRegistry();
    const commandLayer = createMockCommandLayer();

    const { server } = await createMcpAdapter({
      commandLayer,
      schemaRegistry,
      actionRegistry,
    });

    const resources = getResources(server);
    expect(resources["linchkit://schemas"]).toBeDefined();
  });
});

describe("createMcpAdapter — bearer token auth", () => {
  test("authEnabled is false when no bearerToken is provided", async () => {
    const schemaRegistry = createSchemaRegistry();
    const actionRegistry = new ActionRegistry();
    const commandLayer = createMockCommandLayer();

    const { authEnabled, validateAuth } = await createMcpAdapter({
      commandLayer,
      schemaRegistry,
      actionRegistry,
    });

    expect(authEnabled).toBe(false);
    // When no token is configured, any token (or none) passes
    expect(validateAuth(undefined)).toBe(true);
    expect(validateAuth("anything")).toBe(true);
  });

  test("authEnabled is false when bearerToken is empty string", async () => {
    const schemaRegistry = createSchemaRegistry();
    const actionRegistry = new ActionRegistry();
    const commandLayer = createMockCommandLayer();

    const { authEnabled, validateAuth } = await createMcpAdapter({
      commandLayer,
      schemaRegistry,
      actionRegistry,
      bearerToken: "",
    });

    expect(authEnabled).toBe(false);
    expect(validateAuth(undefined)).toBe(true);
  });

  test("authEnabled is true when bearerToken is provided", async () => {
    const schemaRegistry = createSchemaRegistry();
    const actionRegistry = new ActionRegistry();
    const commandLayer = createMockCommandLayer();

    const { authEnabled } = await createMcpAdapter({
      commandLayer,
      schemaRegistry,
      actionRegistry,
      bearerToken: "my-secret-token",
    });

    expect(authEnabled).toBe(true);
  });

  test("validateAuth rejects missing token when auth is enabled", async () => {
    const schemaRegistry = createSchemaRegistry();
    const actionRegistry = new ActionRegistry();
    const commandLayer = createMockCommandLayer();

    const { validateAuth } = await createMcpAdapter({
      commandLayer,
      schemaRegistry,
      actionRegistry,
      bearerToken: "my-secret-token",
    });

    expect(validateAuth(undefined)).toBe(false);
  });

  test("validateAuth rejects wrong token when auth is enabled", async () => {
    const schemaRegistry = createSchemaRegistry();
    const actionRegistry = new ActionRegistry();
    const commandLayer = createMockCommandLayer();

    const { validateAuth } = await createMcpAdapter({
      commandLayer,
      schemaRegistry,
      actionRegistry,
      bearerToken: "my-secret-token",
    });

    expect(validateAuth("wrong-token")).toBe(false);
  });

  test("validateAuth accepts correct token when auth is enabled", async () => {
    const schemaRegistry = createSchemaRegistry();
    const actionRegistry = new ActionRegistry();
    const commandLayer = createMockCommandLayer();

    const { validateAuth } = await createMcpAdapter({
      commandLayer,
      schemaRegistry,
      actionRegistry,
      bearerToken: "my-secret-token",
    });

    expect(validateAuth("my-secret-token")).toBe(true);
  });
});
