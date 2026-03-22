/**
 * MCP Server factory
 *
 * Creates an MCP server that exposes LinchKit actions as MCP tools
 * and schemas as MCP resources. All action invocations go through
 * the CommandLayer pipeline with channel="mcp".
 */

import type {
  ActionRegistry,
  Actor,
  CommandLayer,
  SchemaRegistry,
} from "@linchkit/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fieldsToJsonSchema } from "./field-to-json-schema";
import { generateActionTools } from "./tool-registry";

export interface McpAdapterOptions {
  commandLayer: CommandLayer;
  schemaRegistry: SchemaRegistry;
  actionRegistry: ActionRegistry;
  name?: string;
  version?: string;
  /** Simple bearer token for Phase 1 auth */
  bearerToken?: string;
}

/** Default actor for MCP clients */
const MCP_ACTOR: Actor = {
  type: "ai",
  id: "mcp-client",
  name: "MCP Client",
  groups: ["ai_agent"],
};

/** Create an MCP server adapter wired to the LinchKit runtime */
export async function createMcpAdapter(
  options: McpAdapterOptions,
): Promise<McpServer> {
  const {
    commandLayer,
    schemaRegistry,
    actionRegistry,
    name = "linchkit",
    version = "1.0.0",
  } = options;

  const server = new McpServer({ name, version });

  // Register action tools
  const actionTools = generateActionTools(actionRegistry);
  for (const tool of actionTools) {
    const action = actionRegistry.get(tool.name);
    if (!action) continue;

    // Build zod schema for tool parameters
    const zodShape = buildZodShape(action.input);

    server.tool(tool.name, tool.description, zodShape, async (args) => {
      const result = await commandLayer.execute({
        command: tool.name,
        input: args as Record<string, unknown>,
        channel: "mcp",
        actor: MCP_ACTOR,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    });
  }

  // Register built-in tools
  registerBuiltinTools(server, schemaRegistry, actionRegistry);

  // Register resources
  registerResources(server, schemaRegistry);

  return server;
}

/** Build a Zod shape from FieldDefinition input record */
function buildZodShape(
  input?: Record<string, import("@linchkit/core").FieldDefinition>,
): Record<string, z.ZodTypeAny> {
  if (!input) return {};

  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [name, field] of Object.entries(input)) {
    // Skip non-input types and secret fields
    if (
      field.type === "computed" ||
      field.type === "has_many" ||
      field.type === "many_to_many" ||
      field.secret
    ) {
      continue;
    }

    let zodType: z.ZodTypeAny;

    switch (field.type) {
      case "string":
      case "text":
      case "date":
      case "datetime":
      case "enum":
      case "ref":
      case "state":
        zodType = z.string();
        break;
      case "number":
        zodType = z.number();
        break;
      case "boolean":
        zodType = z.boolean();
        break;
      case "json":
        zodType = z.record(z.unknown());
        break;
      default:
        zodType = z.string();
    }

    if (field.description) {
      zodType = zodType.describe(field.description);
    }

    if (!field.required) {
      zodType = zodType.optional();
    }

    shape[name] = zodType;
  }

  return shape;
}

/** Register built-in introspection tools */
function registerBuiltinTools(
  server: McpServer,
  schemaRegistry: SchemaRegistry,
  actionRegistry: ActionRegistry,
): void {
  // list_schemas
  server.tool(
    "list_schemas",
    "List all available schemas with their names, labels, and descriptions",
    {},
    async () => {
      const schemas = schemaRegistry.getAll().map((s) => ({
        name: s.name,
        label: s.label,
        description: s.description,
      }));

      return {
        content: [{ type: "text" as const, text: JSON.stringify(schemas, null, 2) }],
      };
    },
  );

  // get_schema
  server.tool(
    "get_schema",
    "Get the full definition of a schema by name, including all fields",
    { name: z.string().describe("Schema name") },
    async (args) => {
      const schema = schemaRegistry.get(args.name);
      if (!schema) {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ error: `Schema '${args.name}' not found` }) },
          ],
          isError: true,
        };
      }

      // Convert to a serializable representation with field JSON schemas
      const fieldSchemas = fieldsToJsonSchema(schema.fields);
      const result = {
        name: schema.name,
        label: schema.label,
        description: schema.description,
        fields: fieldSchemas,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // list_actions
  server.tool(
    "list_actions",
    "List all available actions with their names, labels, descriptions, and associated schemas",
    {},
    async () => {
      const actions = actionRegistry.getAll().map((a) => ({
        name: a.name,
        label: a.label,
        description: a.description,
        schema: a.schema,
      }));

      return {
        content: [{ type: "text" as const, text: JSON.stringify(actions, null, 2) }],
      };
    },
  );
}

/** Register MCP resources */
function registerResources(
  server: McpServer,
  schemaRegistry: SchemaRegistry,
): void {
  server.resource(
    "schemas",
    "linchkit://schemas",
    { description: "List of all registered schemas", mimeType: "application/json" },
    async (uri) => {
      const schemas = schemaRegistry.getAll().map((s) => ({
        name: s.name,
        label: s.label,
        description: s.description,
      }));

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(schemas, null, 2),
          },
        ],
      };
    },
  );
}
