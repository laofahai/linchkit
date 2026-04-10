/**
 * MCP Dev Server — Prompt registrations for capability development guidance.
 */

import type { CapabilityDefinition } from "@linchkit/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CollectedDefinitions } from "../commands/startup/collect-capabilities";
import { z } from "./schema";

// Raw shapes for registerPrompt argsSchema. Callback params must be
// explicitly typed to prevent TS2589 from zod v3 deep type inference.
const nameSchema = { name: z.string().describe("Name parameter") };
const entitySchema = { entity: z.string().describe("Target entity name") };
const fromToSchema = {
  from: z.string().describe("Source entity name"),
  to: z.string().describe("Target entity name"),
};

/** Register all prompts on the MCP server. */
export function registerPrompts(
  server: McpServer,
  defs: CollectedDefinitions,
  capabilities: CapabilityDefinition[],
): void {
  // linchkit_develop_capability — step-by-step capability development workflow
  server.registerPrompt(
    "linchkit_develop_capability",
    {
      description: "Step-by-step workflow for developing a new LinchKit capability",
      argsSchema: nameSchema,
    },
    async ({ name }: { name: string }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `You are developing a new LinchKit capability called "${name}".

Follow this step-by-step workflow:

1. **Define Entities** — Use defineEntity() to declare data structures with fields, labels, and validations.
2. **Define Actions** — Use defineAction() for all write operations. Follow verb_noun naming (e.g. create_${name}, update_${name}).
3. **Define Rules** — Use defineRule() for declarative conditions and effects triggered by actions/events.
4. **Define States** — Use defineState() for finite state machines on entity instances.
5. **Define Views** — Use defineView() for UI rendering config (list, form, kanban).
6. **Define Relations** — Use defineRelation() for relationships between entities.
7. **Register Capability** — Use defineCapability() to bundle everything and register extensions.
8. **Test** — Write tests using bun:test to verify all definitions and behavior.

Existing entities in the project: ${defs.entities.map((e) => e.name).join(", ") || "(none)"}
Existing actions in the project: ${defs.actions.map((a) => a.name).join(", ") || "(none)"}

Use the following validation tools to check your definitions:
- linchkit_validate_entity — validates EntityDefinition JSON
- linchkit_validate_action — validates ActionDefinition JSON

Naming conventions:
- Entity names: snake_case (e.g. purchase_order)
- Action names: verb_noun (e.g. submit_request, approve_order)
- Field names: snake_case (e.g. total_amount)
- Comments and docs: English`,
          },
        },
      ],
    }),
  );

  // linchkit_define_entity — guidance for defining an entity
  server.registerPrompt(
    "linchkit_define_entity",
    {
      description: "Guidance and reference for defining a LinchKit entity",
      argsSchema: nameSchema,
    },
    async ({ name }: { name: string }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `You are defining a LinchKit entity called "${name}".

## Field Types and Options

| Type | Description | Key Options |
|------|-------------|-------------|
| string | Short text | min, max, pattern, format |
| text | Long text | min, max |
| number | Numeric value | min, max |
| boolean | True/false | default |
| date | Date only | min, max |
| datetime | Date and time | min, max |
| enum | Fixed set of values | options (required) |
| json | Arbitrary JSON | — |

> **Relationships** between entities are defined using \`defineRelation()\`, not field types. See Spec 46/61.

## System Fields (DO NOT define — auto-managed)
id, tenant_id, created_at, updated_at, created_by, updated_by, _version

## Existing Entities
${defs.entities.map((e) => `- ${e.name}${e.label ? ` (${e.label})` : ""}`).join("\n") || "(none)"}

## Entity Inheritance
Use \`extends: "parent_entity_name"\` to inherit fields from a parent entity.

## Entity Interfaces
Use \`implements: ["interface_name"]\` to implement reusable field contracts defined with defineEntityInterface().

## Code Pattern

\`\`\`typescript
import { defineEntity } from "@linchkit/core";

export const ${name} = defineEntity({
  name: "${name}",
  label: "Your Label",
  description: "Description of the entity",
  fields: {
    field_name: {
      type: "string",
      label: "Field Label",
      required: true,
    },
    // ... more fields
  },
});
\`\`\``,
          },
        },
      ],
    }),
  );

  // linchkit_define_action — guidance for defining an action
  server.registerPrompt(
    "linchkit_define_action",
    {
      description: "Guidance and reference for defining a LinchKit action",
      argsSchema: entitySchema,
    },
    async ({ entity: entityName }: { entity: string }) => {
      const entity = defs.entities.find((e) => e.name === entityName);
      const entityFields = entity ? Object.keys(entity.fields).join(", ") : "(entity not found)";
      const entityActions = defs.actions.filter((a) => a.entity === entityName);

      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `You are defining an action for entity "${entityName}".

## Entity Fields
${entityFields}

## Naming Convention
Action names follow verb_noun pattern: e.g. create_${entityName}, update_${entityName}, delete_${entityName}, submit_${entityName}, approve_${entityName}

## Action Types
- **create** — Creates a new entity instance
- **update** — Modifies an existing entity instance
- **delete** — Removes an entity instance
- **custom** — Any domain-specific operation (e.g. submit, approve, reject)

## Existing Actions for "${entityName}"
${entityActions.map((a) => `- ${a.name}${a.label ? ` (${a.label})` : ""}`).join("\n") || "(none)"}

## Code Pattern

\`\`\`typescript
import { defineAction } from "@linchkit/core";

export const create_${entityName} = defineAction({
  name: "create_${entityName}",
  entity: "${entityName}",
  label: "Create ${entityName}",
  description: "Creates a new ${entityName}",
  input: {
    field_name: {
      type: "string",
      label: "Field Label",
      required: true,
    },
  },
  policy: {
    requiresAuth: true,
  },
  handler: async (ctx) => {
    // Implementation
  },
});
\`\`\`

## Policy Requirements
Every action MUST have a policy object. At minimum: \`{ requiresAuth: true }\`.
Actions are the sole write entry point — all mutations flow through Actions.`,
            },
          },
        ],
      };
    },
  );

  // linchkit_define_relation — guidance for defining a relation
  server.registerPrompt(
    "linchkit_define_relation",
    {
      description: "Guidance and reference for defining a LinchKit relation between entities",
      argsSchema: fromToSchema,
    },
    async ({ from, to }: { from: string; to: string }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `You are defining a relation from entity "${from}" to entity "${to}".

## Cardinality Types
- **one_to_one** — Each instance of "${from}" has exactly one "${to}"
- **one_to_many** — Each "${from}" has many "${to}" instances
- **many_to_one** — Many "${from}" instances reference one "${to}"
- **many_to_many** — Many-to-many via junction table

## Existing Relations
${defs.links.map((r) => `- ${r.name}: ${r.from} → ${r.to} (${r.cardinality})`).join("\n") || "(none)"}

## Code Pattern

\`\`\`typescript
import { defineRelation } from "@linchkit/core";

export const ${from}_${to} = defineRelation({
  name: "${from}_${to}",
  from: "${from}",
  to: "${to}",
  cardinality: "one_to_many",
  label: "${from} to ${to}",
  description: "Describes the relationship",
  required: false,
  cascade: {
    onDelete: "restrict", // "cascade" | "restrict" | "set_null"
    onUpdate: "cascade",
  },
});
\`\`\`

## Cascade Behavior
- **cascade** — Delete/update related records automatically
- **restrict** — Prevent delete/update if related records exist
- **set_null** — Set FK to null on delete/update`,
          },
        },
      ],
    }),
  );

  // linchkit_architecture_guide — overall architecture reference (no args)
  server.registerPrompt(
    "linchkit_architecture_guide",
    {
      description:
        "LinchKit architecture overview: capability types, extension points, pipeline, and boundaries",
    },
    async () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `# LinchKit Architecture Guide

## Capability Types
- **standard** — Business modules (e.g. purchase management, auth)
- **adapter** — Protocol adapters (MCP, A2A, AG-UI)
- **bridge** — Cross-module connectors

## Extension Points

| Extension | Purpose | Example |
|-----------|---------|---------|
| fieldTypes | Custom field types | money, file, address |
| viewTypes | Custom view types | map, gantt, timeline |
| ruleEffects | Custom rule effects | send_sms, create_ticket |
| services | Injectable services | storage, search |
| hooks | Lifecycle hooks | system.start, action.before |
| middlewares | CommandLayer slot middleware | auth, rate-limit |
| transports | Protocol adapters | MCP, A2A, AG-UI |

## CommandLayer Pipeline
All API requests flow through 7 middleware slots in order:
1. **pre** — Pre-processing, request enrichment
2. **auth** — Authentication (JWT, sessions)
3. **exposure** — API exposure control
4. **permission** — Authorization (RBAC)
5. **tenant** — Multi-tenancy isolation
6. **pre-action** — Pre-action hooks, validation
7. **post-action** — Post-action hooks, audit logging

## Core Boundary Rule
Before adding functionality, ask: "Without this, is a zero-capability LinchKit still AI-Native?"
- If yes → it belongs in a capability
- If no → it belongs in core

## Module Boundaries
- core MUST NOT import from any other package
- ui MUST NOT import from server (communicates via HTTP/GraphQL only)
- No circular dependencies between packages
- Dependency flows one way: Capability → Core

## Installed Capabilities
${capabilities.map((c) => `- ${c.name} (${c.type}${c.category ? `, ${c.category}` : ""})`).join("\n") || "(none)"}`,
          },
        },
      ],
    }),
  );
}
