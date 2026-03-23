import { describe, expect, test } from "bun:test";
import type { ActionDefinition } from "@linchkit/core";
import { ActionRegistry } from "@linchkit/core/server";
import { generateActionTools, generateBuiltinTools } from "../src/tool-registry";

function makeAction(overrides: Partial<ActionDefinition> = {}): ActionDefinition {
  return {
    name: "test_action",
    schema: "test",
    label: "Test Action",
    policy: { mode: "sync", transaction: false },
    ...overrides,
  };
}

describe("generateActionTools", () => {
  test("generates tools from action registry", () => {
    const registry = new ActionRegistry();
    registry.register(
      makeAction({
        name: "create_order",
        schema: "order",
        label: "Create Order",
        description: "Creates a new order",
        input: {
          customer_id: { type: "string", required: true },
          amount: { type: "number", min: 0 },
        },
      }),
    );

    const tools = generateActionTools(registry);
    expect(tools).toHaveLength(1);

    const tool = tools[0];
    expect(tool).toBeDefined();
    expect(tool.name).toBe("create_order");
    expect(tool.description).toBe("Create Order: Creates a new order");
    expect(tool.inputSchema).toEqual({
      type: "object",
      properties: {
        customer_id: {
          type: "string",
        },
        amount: { type: "number", minimum: 0 },
      },
      required: ["customer_id"],
    });
  });

  test("filters out actions with mcp exposure disabled", () => {
    const registry = new ActionRegistry();
    registry.register(
      makeAction({
        name: "public_action",
        exposure: "all",
      }),
    );
    registry.register(
      makeAction({
        name: "mcp_disabled",
        exposure: { mcp: false, http: true },
      }),
    );
    registry.register(
      makeAction({
        name: "mcp_enabled",
        exposure: { mcp: true },
      }),
    );
    registry.register(
      makeAction({
        name: "default_exposure",
        // exposure undefined = exposed
      }),
    );

    const tools = generateActionTools(registry);
    const names = tools.map((t) => t.name);
    expect(names).toContain("public_action");
    expect(names).toContain("mcp_enabled");
    expect(names).toContain("default_exposure");
    expect(names).not.toContain("mcp_disabled");
  });

  test("handles actions without input fields", () => {
    const registry = new ActionRegistry();
    registry.register(makeAction({ name: "no_input" }));

    const tools = generateActionTools(registry);
    expect(tools[0]?.inputSchema).toEqual({
      type: "object",
      properties: {},
    });
  });

  test("uses label as description when no description given", () => {
    const registry = new ActionRegistry();
    registry.register(
      makeAction({
        name: "simple",
        label: "Simple Action",
        description: undefined,
      }),
    );

    const tools = generateActionTools(registry);
    expect(tools[0]?.description).toBe("Simple Action");
  });
});

describe("generateBuiltinTools", () => {
  test("returns list_schemas, get_schema, list_actions", () => {
    const tools = generateBuiltinTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("list_schemas");
    expect(names).toContain("get_schema");
    expect(names).toContain("list_actions");
  });

  test("get_schema requires name parameter", () => {
    const tools = generateBuiltinTools();
    const getTool = tools.find((t) => t.name === "get_schema");
    expect(getTool).toBeDefined();
    expect(getTool.inputSchema).toHaveProperty("required");
    expect((getTool.inputSchema as { required: string[] }).required).toContain("name");
  });
});
