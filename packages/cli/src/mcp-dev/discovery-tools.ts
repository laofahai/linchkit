/**
 * MCP Dev Server — Discovery tools for listing and describing entities,
 * actions, relations, and capabilities.
 */

import type { CapabilityDefinition } from "@linchkit/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CollectedDefinitions } from "../commands/startup/collect-capabilities";
import { serializeFields, serializeRelation } from "./helpers";
import { z } from "./schema";

// Pre-declare schemas to avoid TS2589 "excessively deep" errors
// from zod v3 recursive type inference inside registerTool generics.
const nameInputSchema = { name: z.string().describe("Entity or action name") };

/** Register all discovery tools on the MCP server. */
export function registerDiscoveryTools(
  server: McpServer,
  defs: CollectedDefinitions,
  capabilities: CapabilityDefinition[],
): void {
  // linchkit_list_entities
  server.registerTool(
    "linchkit_list_entities",
    {
      description: "List all entities with name, label, and field count",
    },
    async () => {
      const result = defs.entities.map((e) => ({
        name: e.name,
        label: e.label ?? e.name,
        fieldCount: Object.keys(e.fields).length,
        description: e.description,
      }));
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  // linchkit_describe_entity
  // @ts-expect-error — TS2589: zod v3 + MCP SDK registerTool causes deep type recursion
  server.registerTool(
    "linchkit_describe_entity",
    {
      description: "Get full entity definition including fields, types, validations, and relations",
      inputSchema: nameInputSchema,
    },
    async ({ name }) => {
      const entity = defs.entities.find((e) => e.name === name);
      if (!entity) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: `Entity '${name}' not found` }),
            },
          ],
          isError: true,
        };
      }

      // Find relations involving this entity
      const relations = defs.links.filter((r) => r.from === name || r.to === name);

      const result = {
        name: entity.name,
        label: entity.label,
        description: entity.description,
        abstract: entity.abstract,
        extends: entity.extends,
        implements: entity.implements,
        fields: serializeFields(entity.fields),
        relations: relations.map(serializeRelation),
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  // linchkit_list_actions
  server.registerTool(
    "linchkit_list_actions",
    {
      description: "List all actions with name, entity, and description",
    },
    async () => {
      const result = defs.actions.map((a) => ({
        name: a.name,
        entity: a.entity,
        label: a.label,
        description: a.description,
        inputFields: a.input ? Object.keys(a.input) : [],
      }));
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  // linchkit_describe_action
  server.registerTool(
    "linchkit_describe_action",
    {
      description: "Get full action definition including input fields and validations",
      inputSchema: nameInputSchema,
    },
    async ({ name }) => {
      const action = defs.actions.find((a) => a.name === name);
      if (!action) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: `Action '${name}' not found` }),
            },
          ],
          isError: true,
        };
      }

      const result = {
        name: action.name,
        entity: action.entity,
        label: action.label,
        description: action.description,
        input: action.input ? serializeFields(action.input) : undefined,
        output: action.output ? serializeFields(action.output) : undefined,
        stateTransition: action.stateTransition,
        policy: action.policy,
        exposure: action.exposure,
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  // linchkit_list_relations
  server.registerTool(
    "linchkit_list_relations",
    {
      description: "List all relations between entities",
    },
    async () => {
      const result = defs.links.map(serializeRelation);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  // linchkit_list_capabilities
  server.registerTool(
    "linchkit_list_capabilities",
    {
      description: "List installed capabilities with name, type, category, and version",
    },
    async () => {
      const result = capabilities.map((c) => ({
        name: c.name,
        label: c.label,
        type: c.type,
        category: c.category,
        version: c.version,
        description: c.description,
        entityCount: c.entities?.length ?? 0,
        actionCount: c.actions?.length ?? 0,
      }));
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}
