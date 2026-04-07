/**
 * MCP Dev Server — Development-time MCP server for LinchKit project introspection.
 *
 * Exposes entity/action/relation/capability discovery, validation tools,
 * and project resources to AI coding tools (Claude Code, Cursor, etc.).
 *
 * This is NOT the runtime MCP adapter (cap-adapter-mcp). This server reads
 * definitions statically from linchkit.config.ts and never touches live data.
 */

import type {
  ActionDefinition,
  CapabilityDefinition,
  EntityDefinition,
  FieldDefinition,
  FieldType,
  RelationDefinition,
} from "@linchkit/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CollectedDefinitions } from "../commands/startup/collect-capabilities";

// ── Valid field types for validation ────────────────────────────

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

// ── Types ───────────────────────────────────────────────────────

export interface McpDevServerOptions {
  /** Collected definitions from capabilities */
  definitions: CollectedDefinitions;
  /** Raw capability definitions for capability listing */
  capabilities: CapabilityDefinition[];
  /** Project root directory */
  projectRoot: string;
}

// ── Factory ─────────────────────────────────────────────────────

/**
 * Create a development-time MCP server for project introspection.
 * Registers discovery tools, validation tools, utility tools, and resources.
 */
export function createMcpDevServer(options: McpDevServerOptions): McpServer {
  const { definitions, capabilities, projectRoot } = options;

  const server = new McpServer(
    {
      name: "linchkit-dev",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
    },
  );

  registerDiscoveryTools(server, definitions, capabilities);
  registerValidationTools(server, definitions);
  registerUtilityTools(server, definitions, capabilities, projectRoot);
  registerResources(server, definitions);
  registerPrompts(server, definitions, capabilities);

  return server;
}

// ── Discovery tools ─────────────────────────────────────────────

function registerDiscoveryTools(
  server: McpServer,
  defs: CollectedDefinitions,
  capabilities: CapabilityDefinition[],
): void {
  // linchkit_list_entities
  server.tool(
    "linchkit_list_entities",
    "List all entities with name, label, and field count",
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
  server.tool(
    "linchkit_describe_entity",
    "Get full entity definition including fields, types, validations, and relations",
    // biome-ignore lint/suspicious/noExplicitAny: zod v4 vs SDK bundled zod type mismatch
    { name: z.string().describe("Entity name") } as any,
    async (args: { name: string }) => {
      const entity = defs.entities.find((e) => e.name === args.name);
      if (!entity) {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ error: `Entity '${args.name}' not found` }) },
          ],
          isError: true,
        };
      }

      // Find relations involving this entity
      const relations = defs.links.filter((r) => r.from === args.name || r.to === args.name);

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
  server.tool(
    "linchkit_list_actions",
    "List all actions with name, entity, and description",
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
  server.tool(
    "linchkit_describe_action",
    "Get full action definition including input fields and validations",
    // biome-ignore lint/suspicious/noExplicitAny: zod v4 vs SDK bundled zod type mismatch
    { name: z.string().describe("Action name") } as any,
    async (args: { name: string }) => {
      const action = defs.actions.find((a) => a.name === args.name);
      if (!action) {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ error: `Action '${args.name}' not found` }) },
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
  server.tool(
    "linchkit_list_relations",
    "List all relations between entities",
    async () => {
      const result = defs.links.map(serializeRelation);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  // linchkit_list_capabilities
  server.tool(
    "linchkit_list_capabilities",
    "List installed capabilities with name, type, category, and version",
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

// ── Validation tools ────────────────────────────────────────────

function registerValidationTools(server: McpServer, defs: CollectedDefinitions): void {
  // linchkit_validate_entity
  server.tool(
    "linchkit_validate_entity",
    "Validate a proposed EntityDefinition JSON. Checks field types, naming conventions, and references.",
    // biome-ignore lint/suspicious/noExplicitAny: zod v4 vs SDK bundled zod type mismatch
    { definition: z.string().describe("JSON string of the EntityDefinition to validate") } as any,
    async (args: { definition: string }) => {
      const errors: string[] = [];
      const warnings: string[] = [];

      let parsed: EntityDefinition;
      try {
        parsed = JSON.parse(args.definition) as EntityDefinition;
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
            errors.push(`Field '${fieldName}' has invalid type '${field.type}'. Valid: ${VALID_FIELD_TYPES.join(", ")}`);
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
  server.tool(
    "linchkit_validate_action",
    "Validate a proposed ActionDefinition JSON. Checks naming, entity reference, and input fields.",
    // biome-ignore lint/suspicious/noExplicitAny: zod v4 vs SDK bundled zod type mismatch
    { definition: z.string().describe("JSON string of the ActionDefinition to validate") } as any,
    async (args: { definition: string }) => {
      const errors: string[] = [];
      const warnings: string[] = [];

      let parsed: ActionDefinition;
      try {
        parsed = JSON.parse(args.definition) as ActionDefinition;
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
        warnings.push("Action name should follow verb_noun convention (e.g. submit_request, approve_order)");
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

// ── Utility tools ───────────────────────────────────────────────

function registerUtilityTools(
  server: McpServer,
  defs: CollectedDefinitions,
  capabilities: CapabilityDefinition[],
  projectRoot: string,
): void {
  // linchkit_project_overview
  server.tool(
    "linchkit_project_overview",
    "Get full project summary: entity count, action count, relation count, capability count, states, rules, event handlers, automations, views",
    async () => {
      const overview = {
        projectRoot,
        counts: {
          entities: defs.entities.length,
          actions: defs.actions.length,
          relations: defs.links.length,
          capabilities: capabilities.length,
          states: defs.states.length,
          rules: defs.rules.length,
          eventHandlers: defs.eventHandlers.length,
          automations: defs.automations.length,
          views: defs.views.length,
          interfaces: defs.interfaces.length,
        },
        entities: defs.entities.map((e) => e.name),
        capabilities: capabilities.map((c) => ({ name: c.name, type: c.type })),
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(overview, null, 2) }] };
    },
  );

  // linchkit_doctor
  server.tool(
    "linchkit_doctor",
    "Run linch doctor health checks and return results as JSON",
    async () => {
      try {
        const proc = Bun.spawn(["bun", "run", `${projectRoot}/packages/cli/src/index.ts`, "doctor", "--json"], {
          cwd: projectRoot,
          stdout: "pipe",
          stderr: "pipe",
        });
        await proc.exited;
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();

        // Try to parse JSON output from doctor
        try {
          const parsed = JSON.parse(stdout);
          return { content: [{ type: "text" as const, text: JSON.stringify(parsed, null, 2) }] };
        } catch {
          // If not valid JSON, return raw output
          return {
            content: [{ type: "text" as const, text: stdout || stderr || "Doctor returned no output" }],
          };
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: `Failed to run doctor: ${err instanceof Error ? err.message : String(err)}`,
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );
}

// ── Resources ───────────────────────────────────────────────────

function registerResources(server: McpServer, defs: CollectedDefinitions): void {
  // linchkit://ontology — full ontology as JSON
  server.resource("ontology", "linchkit://ontology", { mimeType: "application/json" }, async (uri) => {
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
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(ontology, null, 2) }],
    };
  });

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

// ── Prompts ────────────────────────────────────────────────────

function registerPrompts(
  server: McpServer,
  defs: CollectedDefinitions,
  capabilities: CapabilityDefinition[],
): void {
  // linchkit_develop_capability — step-by-step capability development workflow
  server.prompt(
    "linchkit_develop_capability",
    "Step-by-step workflow for developing a new LinchKit capability",
    // biome-ignore lint/suspicious/noExplicitAny: zod v4 vs SDK type mismatch
    { name: z.string().describe("Capability name to develop") } as any,
    async (args: { name: string }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `You are developing a new LinchKit capability called "${args.name}".

Follow this step-by-step workflow:

1. **Define Entities** — Use defineEntity() to declare data structures with fields, labels, and validations.
2. **Define Actions** — Use defineAction() for all write operations. Follow verb_noun naming (e.g. create_${args.name}, update_${args.name}).
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
  server.prompt(
    "linchkit_define_entity",
    "Guidance and reference for defining a LinchKit entity",
    // biome-ignore lint/suspicious/noExplicitAny: zod v4 vs SDK type mismatch
    { name: z.string().describe("Entity name to define") } as any,
    async (args: { name: string }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `You are defining a LinchKit entity called "${args.name}".

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
| ref | Reference to another entity | entity, required |
| has_many | One-to-many relation | entity |
| many_to_many | Many-to-many relation | entity |
| json | Arbitrary JSON | — |

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

export const ${args.name} = defineEntity({
  name: "${args.name}",
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
  server.prompt(
    "linchkit_define_action",
    "Guidance and reference for defining a LinchKit action",
    // biome-ignore lint/suspicious/noExplicitAny: zod v4 vs SDK type mismatch
    { entity: z.string().describe("Target entity name") } as any,
    async (args: { entity: string }) => {
      const entity = defs.entities.find((e) => e.name === args.entity);
      const entityFields = entity ? Object.keys(entity.fields).join(", ") : "(entity not found)";
      const entityActions = defs.actions.filter((a) => a.entity === args.entity);

      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `You are defining an action for entity "${args.entity}".

## Entity Fields
${entityFields}

## Naming Convention
Action names follow verb_noun pattern: e.g. create_${args.entity}, update_${args.entity}, delete_${args.entity}, submit_${args.entity}, approve_${args.entity}

## Action Types
- **create** — Creates a new entity instance
- **update** — Modifies an existing entity instance
- **delete** — Removes an entity instance
- **custom** — Any domain-specific operation (e.g. submit, approve, reject)

## Existing Actions for "${args.entity}"
${entityActions.map((a) => `- ${a.name}${a.label ? ` (${a.label})` : ""}`).join("\n") || "(none)"}

## Code Pattern

\`\`\`typescript
import { defineAction } from "@linchkit/core";

export const create_${args.entity} = defineAction({
  name: "create_${args.entity}",
  entity: "${args.entity}",
  label: "Create ${args.entity}",
  description: "Creates a new ${args.entity}",
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
  server.prompt(
    "linchkit_define_relation",
    "Guidance and reference for defining a LinchKit relation between entities",
    // biome-ignore lint/suspicious/noExplicitAny: zod v4 vs SDK type mismatch
    { from: z.string().describe("Source entity name"), to: z.string().describe("Target entity name") } as any,
    async (args: { from: string; to: string }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `You are defining a relation from entity "${args.from}" to entity "${args.to}".

## Cardinality Types
- **one_to_one** — Each instance of "${args.from}" has exactly one "${args.to}"
- **one_to_many** — Each "${args.from}" has many "${args.to}" instances
- **many_to_one** — Many "${args.from}" instances reference one "${args.to}"
- **many_to_many** — Many-to-many via junction table

## Existing Relations
${defs.links.map((r) => `- ${r.name}: ${r.from} → ${r.to} (${r.cardinality})`).join("\n") || "(none)"}

## Code Pattern

\`\`\`typescript
import { defineRelation } from "@linchkit/core";

export const ${args.from}_${args.to} = defineRelation({
  name: "${args.from}_${args.to}",
  from: "${args.from}",
  to: "${args.to}",
  cardinality: "one_to_many",
  label: "${args.from} to ${args.to}",
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
  server.prompt(
    "linchkit_architecture_guide",
    "LinchKit architecture overview: capability types, extension points, pipeline, and boundaries",
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

// ── Helpers ─────────────────────────────────────────────────────

/** Serialize fields to a JSON-safe representation */
function serializeFields(fields: Record<string, FieldDefinition>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(fields)) {
    const serialized: Record<string, unknown> = {
      type: field.type,
      label: field.label,
    };
    if (field.description) serialized.description = field.description;
    if (field.required) serialized.required = true;
    if (field.unique) serialized.unique = true;
    if (field.default !== undefined) serialized.default = field.default;
    if (field.min !== undefined) serialized.min = field.min;
    if (field.max !== undefined) serialized.max = field.max;
    if (field.format) serialized.format = field.format;
    if (field.pattern) serialized.pattern = field.pattern;
    if (field.immutable) serialized.immutable = true;
    // Type-specific properties
    if (field.type === "enum") {
      serialized.options = field.options;
    }
    if (field.type === "state") {
      serialized.machine = field.machine;
    }
    result[name] = serialized;
  }
  return result;
}

/** Serialize a relation definition */
function serializeRelation(r: RelationDefinition): Record<string, unknown> {
  return {
    name: r.name,
    from: r.from,
    to: r.to,
    cardinality: r.cardinality,
    label: r.label,
    description: r.description,
    required: r.required,
    cascade: r.cascade,
  };
}
