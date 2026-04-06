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
  "ref",
  "has_many",
  "many_to_many",
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
      },
    },
  );

  registerDiscoveryTools(server, definitions, capabilities);
  registerValidationTools(server, definitions);
  registerUtilityTools(server, definitions, capabilities, projectRoot);
  registerResources(server, definitions);

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
          // Check ref has target
          if (field.type === "ref") {
            const refField = field as { target?: string };
            if (!refField.target) {
              errors.push(`Ref field '${fieldName}' must have a 'target' property pointing to target entity`);
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
    if (field.type === "ref" || field.type === "has_many" || field.type === "many_to_many") {
      serialized.target = field.target;
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
