/**
 * Tests for MCP Dev Server prompt handlers.
 *
 * Verifies that all prompts are registered and return dynamic content
 * based on project definitions.
 */

import { describe, expect, test } from "bun:test";
import type {
  ActionDefinition,
  CapabilityDefinition,
  EntityDefinition,
  RelationDefinition,
} from "@linchkit/core";
import type { CollectedDefinitions } from "../src/commands/startup/collect-capabilities";
import { createMcpDevServer } from "../src/mcp-dev/server";

// ── Mock data ───────────────────────────────────────────────────

const mockEntity: EntityDefinition = {
  name: "purchase_request",
  label: "Purchase Request",
  description: "A request to purchase goods or services",
  fields: {
    title: { type: "string", label: "Title", required: true },
    amount: { type: "number", label: "Amount", required: true, min: 0 },
    status: { type: "enum", label: "Status", options: ["draft", "submitted", "approved"] },
  },
};

const mockEntity2: EntityDefinition = {
  name: "department",
  label: "Department",
  fields: {
    name: { type: "string", label: "Name", required: true },
    code: { type: "string", label: "Code", required: true, unique: true },
  },
};

const mockAction: ActionDefinition = {
  name: "submit_request",
  entity: "purchase_request",
  label: "Submit Request",
  description: "Submit a purchase request for approval",
  input: {
    title: { type: "string", label: "Title", required: true },
    amount: { type: "number", label: "Amount", required: true },
  },
  policy: { requiresAuth: true },
};

const mockRelation: RelationDefinition = {
  name: "department_requests",
  from: "department",
  to: "purchase_request",
  cardinality: "one_to_many",
  fromName: "requests",
  toName: "department",
  label: { from: "Requests", to: "Department" },
};

const mockCapability: CapabilityDefinition = {
  name: "cap-purchase",
  label: "Purchase Management",
  type: "standard",
  category: "business",
  version: "0.1.0",
  description: "Purchase request management",
  entities: [mockEntity, mockEntity2],
  actions: [mockAction],
  relations: [mockRelation],
};

const mockDefinitions: CollectedDefinitions = {
  interfaces: [],
  entities: [mockEntity, mockEntity2],
  actions: [mockAction],
  views: [],
  states: [],
  links: [mockRelation],
  rules: [],
  eventHandlers: [],
  middlewares: [],
  transports: [],
  graphqlExtensions: [],
  commands: [],
};

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Call a prompt on the MCP server by name and return the result.
 * Uses the server's internal _registeredPrompts object.
 */
async function callPrompt(
  server: ReturnType<typeof createMcpDevServer>,
  promptName: string,
  args: Record<string, string> = {},
): Promise<{ messages: Array<{ role: string; content: { type: string; text: string } }> }> {
  // biome-ignore lint/suspicious/noExplicitAny: accessing internal for testing
  const registeredPrompts = (server as any)._registeredPrompts as Record<
    string,
    { callback: (...args: never[]) => unknown }
  >;

  const prompt = registeredPrompts?.[promptName];
  if (!prompt) {
    throw new Error(
      `Prompt '${promptName}' not registered. Available: ${Object.keys(registeredPrompts ?? {}).join(", ")}`,
    );
  }

  return prompt.callback(args, {}) as ReturnType<typeof callPrompt>;
}

// ── Tests ───────────────────────────────────────────────────────

describe("MCP Dev Server Prompts", () => {
  const server = createMcpDevServer({
    definitions: mockDefinitions,
    capabilities: [mockCapability],
    projectRoot: "/tmp/test-project",
  });

  test("all 5 prompts are registered", () => {
    // biome-ignore lint/suspicious/noExplicitAny: accessing internal for testing
    const registeredPrompts = (server as any)._registeredPrompts as Record<string, unknown>;
    const promptNames = Object.keys(registeredPrompts ?? {});

    expect(promptNames).toContain("linchkit_develop_capability");
    expect(promptNames).toContain("linchkit_define_entity");
    expect(promptNames).toContain("linchkit_define_action");
    expect(promptNames).toContain("linchkit_define_relation");
    expect(promptNames).toContain("linchkit_architecture_guide");
    expect(promptNames.length).toBeGreaterThanOrEqual(5);
  });

  test("linchkit_develop_capability includes capability name and existing entities", async () => {
    const result = await callPrompt(server, "linchkit_develop_capability", { name: "inventory" });

    expect(result.messages).toHaveLength(1);
    const text = result.messages[0].content.text;
    expect(text).toContain("inventory");
    expect(text).toContain("purchase_request");
    expect(text).toContain("department");
    expect(text).toContain("submit_request");
    expect(text).toContain("defineEntity");
    expect(text).toContain("defineAction");
    expect(text).toContain("verb_noun");
  });

  test("linchkit_define_entity includes entity name and field types", async () => {
    const result = await callPrompt(server, "linchkit_define_entity", { name: "invoice" });

    const text = result.messages[0].content.text;
    expect(text).toContain("invoice");
    expect(text).toContain("string");
    expect(text).toContain("number");
    expect(text).toContain("enum");
    expect(text).toContain("json");
    expect(text).toContain("defineEntity");
    expect(text).toContain("purchase_request");
    // System fields warning
    expect(text).toContain("id");
    expect(text).toContain("tenant_id");
    expect(text).toContain("created_at");
  });

  test("linchkit_define_action includes entity fields and existing actions", async () => {
    const result = await callPrompt(server, "linchkit_define_action", {
      entity: "purchase_request",
    });

    const text = result.messages[0].content.text;
    expect(text).toContain("purchase_request");
    expect(text).toContain("title");
    expect(text).toContain("amount");
    expect(text).toContain("submit_request");
    expect(text).toContain("defineAction");
    expect(text).toContain("policy");
    expect(text).toContain("requiresAuth");
  });

  test("linchkit_define_action handles unknown entity gracefully", async () => {
    const result = await callPrompt(server, "linchkit_define_action", { entity: "nonexistent" });

    const text = result.messages[0].content.text;
    expect(text).toContain("nonexistent");
    expect(text).toContain("entity not found");
  });

  test("linchkit_define_relation includes from/to entities and existing relations", async () => {
    const result = await callPrompt(server, "linchkit_define_relation", {
      from: "department",
      to: "purchase_request",
    });

    const text = result.messages[0].content.text;
    expect(text).toContain("department");
    expect(text).toContain("purchase_request");
    expect(text).toContain("one_to_many");
    expect(text).toContain("many_to_many");
    expect(text).toContain("defineRelation");
    expect(text).toContain("cascade");
    expect(text).toContain("department_requests");
  });

  test("linchkit_architecture_guide includes capability types and installed capabilities", async () => {
    const result = await callPrompt(server, "linchkit_architecture_guide");

    const text = result.messages[0].content.text;
    expect(text).toContain("standard");
    expect(text).toContain("adapter");
    expect(text).toContain("bridge");
    expect(text).toContain("fieldTypes");
    expect(text).toContain("viewTypes");
    expect(text).toContain("middlewares");
    expect(text).toContain("CommandLayer");
    expect(text).toContain("cap-purchase");
    expect(text).toContain("pre");
    expect(text).toContain("post-action");
  });
});
