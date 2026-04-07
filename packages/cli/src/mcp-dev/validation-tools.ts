/**
 * MCP Dev Server — Validation tools for checking entity and action definitions.
 */

import type { ActionDefinition, EntityDefinition, FieldType } from "@linchkit/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CollectedDefinitions } from "../commands/startup/collect-capabilities";
import { z } from "./schema";

// Pre-declare schemas to avoid TS2589 "excessively deep" errors
// from zod v3 recursive type inference inside registerTool generics.
const definitionInputSchema = {
  definition: z.string().describe("JSON string of the definition to validate"),
};

// Valid field types for validation
const VALID_FIELD_TYPES: readonly string[] = [
  "string",
  "text",
  "number",
  "boolean",
  "date",
  "datetime",
  "enum",
  "json",
  "state",
  "computed",
] satisfies FieldType[];

/** Register all validation tools on the MCP server. */
export function registerValidationTools(server: McpServer, defs: CollectedDefinitions): void {
  // linchkit_validate_entity
  // @ts-expect-error — TS2589: zod v3 + MCP SDK registerTool causes deep type recursion
  server.registerTool(
    "linchkit_validate_entity",
    {
      description:
        "Validate a proposed EntityDefinition JSON. Checks field types, naming conventions, and references.",
      inputSchema: definitionInputSchema,
    },
    async ({ definition }) => {
      const errors: string[] = [];
      const warnings: string[] = [];

      let parsed: EntityDefinition;
      try {
        parsed = JSON.parse(definition) as EntityDefinition;
      } catch {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ valid: false, errors: ["Invalid JSON"] }),
            },
          ],
        };
      }

      // Check required name
      if (!parsed.name) {
        errors.push("Entity name is required");
      } else if (!/^[a-z][a-z0-9_]*$/.test(parsed.name)) {
        errors.push("Entity name must be snake_case (lowercase, underscores, start with letter)");
      }

      // Check for duplicate name
      if (parsed.name && defs.entities.some((e) => e.name === parsed.name)) {
        warnings.push(`Entity '${parsed.name}' already exists — this would override it`);
      }

      // Check fields
      if (!parsed.fields || typeof parsed.fields !== "object") {
        errors.push("Entity must have a fields object");
      } else {
        for (const [fieldName, field] of Object.entries(parsed.fields)) {
          if (!/^[a-z][a-z0-9_]*$/.test(fieldName)) {
            errors.push(`Field '${fieldName}' must be snake_case`);
          }
          if (!field.type) {
            errors.push(`Field '${fieldName}' is missing 'type'`);
          } else if (!VALID_FIELD_TYPES.includes(field.type)) {
            errors.push(
              `Field '${fieldName}' has invalid type '${field.type}'. Valid: ${VALID_FIELD_TYPES.join(", ")}`,
            );
          }
          // Check enum has options
          if (field.type === "enum") {
            const enumField = field as { options?: unknown[] };
            if (!enumField.options || enumField.options.length === 0) {
              errors.push(`Enum field '${fieldName}' must have options[]`);
            }
          }
        }
      }

      // Check extends target exists
      if (parsed.extends && !defs.entities.some((e) => e.name === parsed.extends)) {
        warnings.push(`Parent entity '${parsed.extends}' not found in current definitions`);
      }

      const valid = errors.length === 0;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ valid, errors, warnings }, null, 2),
          },
        ],
      };
    },
  );

  // linchkit_validate_action
  server.registerTool(
    "linchkit_validate_action",
    {
      description:
        "Validate a proposed ActionDefinition JSON. Checks naming, entity reference, and input fields.",
      inputSchema: definitionInputSchema,
    },
    async ({ definition }) => {
      const errors: string[] = [];
      const warnings: string[] = [];

      let parsed: ActionDefinition;
      try {
        parsed = JSON.parse(definition) as ActionDefinition;
      } catch {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ valid: false, errors: ["Invalid JSON"] }),
            },
          ],
        };
      }

      // Check required name (verb_noun convention)
      if (!parsed.name) {
        errors.push("Action name is required");
      } else if (!/^[a-z][a-z0-9_]*$/.test(parsed.name)) {
        errors.push("Action name must be snake_case");
      } else if (!parsed.name.includes("_")) {
        warnings.push(
          "Action name should follow verb_noun convention (e.g. submit_request, approve_order)",
        );
      }

      // Check entity reference
      if (!parsed.entity) {
        errors.push("Action must reference an entity");
      } else if (!defs.entities.some((e) => e.name === parsed.entity)) {
        warnings.push(`Entity '${parsed.entity}' not found in current definitions`);
      }

      // Check label
      if (!parsed.label) {
        errors.push("Action must have a label");
      }

      // Check input fields if present
      if (parsed.input) {
        for (const [fieldName, field] of Object.entries(parsed.input)) {
          if (!field.type) {
            errors.push(`Input field '${fieldName}' is missing 'type'`);
          } else if (!VALID_FIELD_TYPES.includes(field.type)) {
            errors.push(`Input field '${fieldName}' has invalid type '${field.type}'`);
          }
        }
      }

      // Check policy
      if (!parsed.policy) {
        errors.push("Action must have a policy (e.g. { requiresAuth: true })");
      }

      const valid = errors.length === 0;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ valid, errors, warnings }, null, 2),
          },
        ],
      };
    },
  );
}
