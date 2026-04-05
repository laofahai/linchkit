/**
 * Tool registry — generates MCP tool definitions from ActionRegistry
 *
 * Converts LinchKit ActionDefinitions into MCP-compatible tool definitions,
 * filtering by exposure settings and generating appropriate input schemas.
 */

import type { ActionDefinition, ActionRegistry } from "@linchkit/core";
import { fieldsToJsonSchema } from "./field-to-json-schema";

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Check whether an action should be exposed via MCP */
function isMcpExposed(action: ActionDefinition): boolean {
  if (action.exposure === undefined || action.exposure === "all") {
    return true;
  }
  return action.exposure.mcp !== false;
}

/** Generate MCP tool definitions from all MCP-exposed actions */
export function generateActionTools(registry: ActionRegistry): McpToolDef[] {
  const actions = registry.getAll();
  const tools: McpToolDef[] = [];

  for (const action of actions) {
    if (!isMcpExposed(action)) continue;

    const description = action.description
      ? `${action.label}: ${action.description}`
      : action.label;

    const inputSchema = action.input
      ? fieldsToJsonSchema(action.input)
      : { type: "object" as const, properties: {} };

    tools.push({
      name: action.name,
      description,
      inputSchema,
    });
  }

  return tools;
}

/** Generate built-in MCP tools for schema/action/rule/state introspection */
export function generateBuiltinTools(): McpToolDef[] {
  return [
    {
      name: "list_schemas",
      description:
        "List all available schemas with their names, labels, descriptions, and field names",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_schema",
      description:
        "Get the full definition of a schema by name, including all fields with types and constraints",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Schema name" },
        },
        required: ["name"],
      },
    },
    {
      name: "list_actions",
      description:
        "List all available actions with their names, labels, descriptions, schemas, and input field summaries",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_rules",
      description: "List business rules, optionally filtered by entity or action name",
      inputSchema: {
        type: "object",
        properties: {
          entity: { type: "string", description: "Filter rules by entity name" },
          action: { type: "string", description: "Filter rules by action name" },
        },
      },
    },
    {
      name: "get_state_machine",
      description:
        "Get the state machine definition for an entity, including states, transitions, and metadata",
      inputSchema: {
        type: "object",
        properties: {
          entity: { type: "string", description: "Entity name to get state machine for" },
        },
        required: ["entity"],
      },
    },
    {
      name: "query",
      description: "Execute a GraphQL query against the LinchKit server",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "GraphQL query string" },
          variables: { type: "object", description: "GraphQL variables" },
        },
        required: ["query"],
      },
    },
  ];
}
