/**
 * MCP Dev Server — Resource registrations for ontology, entity, and action resources.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CollectedDefinitions } from "../commands/startup/collect-capabilities";
import { serializeFields, serializeRelation } from "./helpers";

/** Register all resources on the MCP server. */
export function registerResources(server: McpServer, defs: CollectedDefinitions): void {
  // linchkit://ontology — full ontology as JSON
  server.resource(
    "ontology",
    "linchkit://ontology",
    { mimeType: "application/json" },
    async (uri) => {
      const ontology = {
        entities: defs.entities.map((e) => ({
          name: e.name,
          label: e.label,
          description: e.description,
          fields: serializeFields(e.fields),
        })),
        actions: defs.actions.map((a) => ({
          name: a.name,
          entity: a.entity,
          label: a.label,
          description: a.description,
        })),
        relations: defs.links.map(serializeRelation),
        states: defs.states.map((s) => ({
          name: s.name,
          entity: s.entity,
          field: s.field,
          initial: s.initial,
          states: s.states,
        })),
      };
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(ontology, null, 2),
          },
        ],
      };
    },
  );

  // linchkit://entity/{name} — entity definition as JSON
  for (const entity of defs.entities) {
    server.resource(
      `entity-${entity.name}`,
      `linchkit://entity/${entity.name}`,
      { mimeType: "application/json" },
      async (uri) => {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(
                {
                  name: entity.name,
                  label: entity.label,
                  description: entity.description,
                  fields: serializeFields(entity.fields),
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    );
  }

  // linchkit://action/{name} — action definition as JSON
  for (const action of defs.actions) {
    server.resource(
      `action-${action.name}`,
      `linchkit://action/${action.name}`,
      { mimeType: "application/json" },
      async (uri) => {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(
                {
                  name: action.name,
                  entity: action.entity,
                  label: action.label,
                  description: action.description,
                  input: action.input ? serializeFields(action.input) : undefined,
                  policy: action.policy,
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    );
  }
}
