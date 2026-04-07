/**
 * Tests for MCP Dev Server tool handlers.
 *
 * Uses mock config/capabilities to verify tool responses without
 * starting the full MCP transport.
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
    notes: { type: "text", label: "Notes" },
    department_id: { type: "ref", label: "Department", target: "department" },
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
  automations: [],
  middlewares: [],
  transports: [],
  graphqlExtensions: [],
  commands: [],
};

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Call a tool on the MCP server by name and return the parsed JSON result.
 * Uses the server's internal _registeredTools object (McpServer internals).
 */
async function callTool(
  server: ReturnType<typeof createMcpDevServer>,
  toolName: string,
  args: Record<string, unknown> = {},
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  // biome-ignore lint/suspicious/noExplicitAny: accessing internal for testing
  const registeredTools = (server as any)._registeredTools as Record<string, { handler: (...args: never[]) => unknown }>;

  const tool = registeredTools?.[toolName];
  if (!tool) {
    throw new Error(`Tool '${toolName}' not registered. Available: ${Object.keys(registeredTools ?? {}).join(", ")}`);
  }

  return tool.handler(args, {}) as ReturnType<typeof callTool>;
}

// ── Tests ───────────────────────────────────────────────────────

describe("MCP Dev Server", () => {
  const server = createMcpDevServer({
    definitions: mockDefinitions,
    capabilities: [mockCapability],
    projectRoot: "/tmp/test-project",
  });

  describe("linchkit_list_entities", () => {
    test("returns all entities with name, label, fieldCount", async () => {
      const result = await callTool(server, "linchkit_list_entities");
      const data = JSON.parse(result.content[0]?.text);

      expect(data).toHaveLength(2);
      expect(data[0].name).toBe("purchase_request");
      expect(data[0].label).toBe("Purchase Request");
      expect(data[0].fieldCount).toBe(5);
      expect(data[1].name).toBe("department");
      expect(data[1].fieldCount).toBe(2);
    });
  });

  describe("linchkit_describe_entity", () => {
    test("returns entity details with fields and relations", async () => {
      const result = await callTool(server, "linchkit_describe_entity", {
        name: "purchase_request",
      });
      const data = JSON.parse(result.content[0]?.text);

      expect(data.name).toBe("purchase_request");
      expect(data.label).toBe("Purchase Request");
      expect(data.fields.title).toBeDefined();
      expect(data.fields.title.type).toBe("string");
      expect(data.fields.title.required).toBe(true);
      expect(data.fields.amount.min).toBe(0);
      expect(data.relations).toHaveLength(1);
      expect(data.relations[0].name).toBe("department_requests");
    });

    test("returns error for unknown entity", async () => {
      const result = await callTool(server, "linchkit_describe_entity", {
        name: "nonexistent",
      });

      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0]?.text);
      expect(data.error).toContain("not found");
    });
  });

  describe("linchkit_list_actions", () => {
    test("returns all actions with name, entity, description", async () => {
      const result = await callTool(server, "linchkit_list_actions");
      const data = JSON.parse(result.content[0]?.text);

      expect(data).toHaveLength(1);
      expect(data[0].name).toBe("submit_request");
      expect(data[0].entity).toBe("purchase_request");
      expect(data[0].inputFields).toEqual(["title", "amount"]);
    });
  });

  describe("linchkit_describe_action", () => {
    test("returns action details with input fields", async () => {
      const result = await callTool(server, "linchkit_describe_action", {
        name: "submit_request",
      });
      const data = JSON.parse(result.content[0]?.text);

      expect(data.name).toBe("submit_request");
      expect(data.entity).toBe("purchase_request");
      expect(data.input.title.type).toBe("string");
      expect(data.policy.requiresAuth).toBe(true);
    });

    test("returns error for unknown action", async () => {
      const result = await callTool(server, "linchkit_describe_action", {
        name: "nonexistent",
      });
      expect(result.isError).toBe(true);
    });
  });

  describe("linchkit_list_relations", () => {
    test("returns all relations", async () => {
      const result = await callTool(server, "linchkit_list_relations");
      const data = JSON.parse(result.content[0]?.text);

      expect(data).toHaveLength(1);
      expect(data[0].name).toBe("department_requests");
      expect(data[0].from).toBe("department");
      expect(data[0].to).toBe("purchase_request");
      expect(data[0].cardinality).toBe("one_to_many");
    });
  });

  describe("linchkit_list_capabilities", () => {
    test("returns capability info", async () => {
      const result = await callTool(server, "linchkit_list_capabilities");
      const data = JSON.parse(result.content[0]?.text);

      expect(data).toHaveLength(1);
      expect(data[0].name).toBe("cap-purchase");
      expect(data[0].type).toBe("standard");
      expect(data[0].entityCount).toBe(2);
      expect(data[0].actionCount).toBe(1);
    });
  });

  describe("linchkit_project_overview", () => {
    test("returns project summary counts", async () => {
      const result = await callTool(server, "linchkit_project_overview");
      const data = JSON.parse(result.content[0]?.text);

      expect(data.counts.entities).toBe(2);
      expect(data.counts.actions).toBe(1);
      expect(data.counts.relations).toBe(1);
      expect(data.counts.capabilities).toBe(1);
      expect(data.entities).toEqual(["purchase_request", "department"]);
    });
  });

  describe("linchkit_validate_entity", () => {
    test("validates a correct entity definition", async () => {
      const valid = {
        name: "invoice",
        label: "Invoice",
        fields: {
          number: { type: "string", label: "Number", required: true },
          total: { type: "number", label: "Total" },
        },
      };

      const result = await callTool(server, "linchkit_validate_entity", {
        definition: JSON.stringify(valid),
      });
      const data = JSON.parse(result.content[0]?.text);

      expect(data.valid).toBe(true);
      expect(data.errors).toHaveLength(0);
    });

    test("catches invalid JSON", async () => {
      const result = await callTool(server, "linchkit_validate_entity", {
        definition: "not json",
      });
      const data = JSON.parse(result.content[0]?.text);

      expect(data.valid).toBe(false);
      expect(data.errors).toContain("Invalid JSON");
    });

    test("catches missing name", async () => {
      const result = await callTool(server, "linchkit_validate_entity", {
        definition: JSON.stringify({ fields: {} }),
      });
      const data = JSON.parse(result.content[0]?.text);

      expect(data.valid).toBe(false);
      expect(data.errors).toContain("Entity name is required");
    });

    test("catches non-snake_case name", async () => {
      const result = await callTool(server, "linchkit_validate_entity", {
        definition: JSON.stringify({ name: "MyEntity", fields: {} }),
      });
      const data = JSON.parse(result.content[0]?.text);

      expect(data.valid).toBe(false);
      expect(data.errors.some((e: string) => e.includes("snake_case"))).toBe(true);
    });

    test("catches invalid field types", async () => {
      const result = await callTool(server, "linchkit_validate_entity", {
        definition: JSON.stringify({
          name: "test_entity",
          fields: { bad_field: { type: "invalid_type" } },
        }),
      });
      const data = JSON.parse(result.content[0]?.text);

      expect(data.valid).toBe(false);
      expect(data.errors.some((e: string) => e.includes("invalid type"))).toBe(true);
    });

    test("catches enum without options", async () => {
      const result = await callTool(server, "linchkit_validate_entity", {
        definition: JSON.stringify({
          name: "test_entity",
          fields: { status: { type: "enum" } },
        }),
      });
      const data = JSON.parse(result.content[0]?.text);

      expect(data.valid).toBe(false);
      expect(data.errors.some((e: string) => e.includes("options"))).toBe(true);
    });

    test("warns about duplicate entity name", async () => {
      const result = await callTool(server, "linchkit_validate_entity", {
        definition: JSON.stringify({
          name: "purchase_request",
          fields: { title: { type: "string" } },
        }),
      });
      const data = JSON.parse(result.content[0]?.text);

      expect(data.valid).toBe(true);
      expect(data.warnings.some((w: string) => w.includes("already exists"))).toBe(true);
    });

    test("catches missing fields object", async () => {
      const result = await callTool(server, "linchkit_validate_entity", {
        definition: JSON.stringify({ name: "test_entity" }),
      });
      const data = JSON.parse(result.content[0]?.text);

      expect(data.valid).toBe(false);
      expect(data.errors.some((e: string) => e.includes("fields object"))).toBe(true);
    });
  });

  describe("linchkit_validate_action", () => {
    test("validates a correct action definition", async () => {
      const valid = {
        name: "create_invoice",
        entity: "purchase_request",
        label: "Create Invoice",
        input: { amount: { type: "number" } },
        policy: { requiresAuth: true },
      };

      const result = await callTool(server, "linchkit_validate_action", {
        definition: JSON.stringify(valid),
      });
      const data = JSON.parse(result.content[0]?.text);

      expect(data.valid).toBe(true);
      expect(data.errors).toHaveLength(0);
    });

    test("catches missing entity", async () => {
      const result = await callTool(server, "linchkit_validate_action", {
        definition: JSON.stringify({
          name: "do_thing",
          label: "Do Thing",
          policy: { requiresAuth: true },
        }),
      });
      const data = JSON.parse(result.content[0]?.text);

      expect(data.valid).toBe(false);
      expect(data.errors.some((e: string) => e.includes("entity"))).toBe(true);
    });

    test("warns about non verb_noun naming", async () => {
      const result = await callTool(server, "linchkit_validate_action", {
        definition: JSON.stringify({
          name: "invoice",
          entity: "purchase_request",
          label: "Invoice",
          policy: { requiresAuth: true },
        }),
      });
      const data = JSON.parse(result.content[0]?.text);

      expect(data.valid).toBe(true);
      expect(data.warnings.some((w: string) => w.includes("verb_noun"))).toBe(true);
    });

    test("catches missing policy", async () => {
      const result = await callTool(server, "linchkit_validate_action", {
        definition: JSON.stringify({
          name: "create_invoice",
          entity: "purchase_request",
          label: "Create Invoice",
        }),
      });
      const data = JSON.parse(result.content[0]?.text);

      expect(data.valid).toBe(false);
      expect(data.errors.some((e: string) => e.includes("policy"))).toBe(true);
    });
  });
});
