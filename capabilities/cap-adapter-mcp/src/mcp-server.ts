/**
 * MCP Server factory
 *
 * Creates an MCP server that exposes LinchKit actions as MCP tools
 * and schemas as MCP resources. All action invocations go through
 * the CommandLayer pipeline with channel="mcp".
 *
 * Introspection tools allow AI agents to discover the full system
 * capabilities: schemas, actions, rules, state machines, and GraphQL queries.
 *
 * Note: We use `as any` casts when passing Zod schemas to the MCP SDK because
 * the SDK bundles its own zod v3 (3.25.x) while the project uses zod v4.
 * TypeScript sees them as incompatible types despite being structurally identical.
 * The MCP SDK's zod-compat layer handles both v3 and v4 at runtime.
 */

import type {
  ActionRegistry,
  Actor,
  CommandLayer,
  RuleDefinition,
  SchemaRegistry,
  StateDefinition,
} from "@linchkit/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fieldsToJsonSchema } from "./field-to-json-schema";
import { registerScaffoldTools } from "./scaffold-tools";
import { generateActionTools } from "./tool-registry";

export interface McpAdapterOptions {
  commandLayer: CommandLayer;
  schemaRegistry: SchemaRegistry;
  actionRegistry: ActionRegistry;
  /** Rule definitions for introspection */
  rules?: RuleDefinition[];
  /** State machine definitions for introspection */
  states?: StateDefinition[];
  /** GraphQL endpoint URL for query proxy (e.g. "http://localhost:3001/graphql") */
  graphqlEndpoint?: string;
  /** Tenant ID for multi-tenant scoping (forwarded as x-tenant-id to GraphQL) */
  tenantId?: string;
  name?: string;
  version?: string;
  /**
   * Bearer token for Phase 1 auth.
   *
   * Auth strategy by transport:
   * - **stdio**: Process-level security — the token is stored but not enforced
   *   (the client process is already trusted).
   * - **SSE**: HTTP Bearer header validation — enforced at the HTTP transport
   *   level (see M1b 1.4).
   */
  bearerToken?: string;
}

/**
 * Result of createMcpAdapter — the McpServer plus auth utilities.
 */
export interface McpAdapterResult {
  server: McpServer;
  /**
   * Validate a bearer token against the configured token.
   * Returns true if auth passes (no token configured = always passes).
   */
  validateAuth: (token: string | undefined) => boolean;
  /** Whether bearer token auth is configured */
  authEnabled: boolean;
}

/** Default actor for MCP clients */
const MCP_ACTOR: Actor = {
  type: "ai",
  id: "mcp-client",
  name: "MCP Client",
  groups: ["ai_agent"],
};

/** Create an MCP server adapter wired to the LinchKit runtime */
export async function createMcpAdapter(options: McpAdapterOptions): Promise<McpAdapterResult> {
  const {
    commandLayer,
    schemaRegistry,
    actionRegistry,
    rules = [],
    states = [],
    graphqlEndpoint,
    tenantId,
    name = "linchkit",
    version = "1.0.0",
    bearerToken,
  } = options;

  const server = new McpServer({ name, version });

  // Build auth validator.
  // When no token is configured, auth is not enforced (open access).
  // When a token is configured, the provided token must match exactly.
  const authEnabled = typeof bearerToken === "string" && bearerToken.length > 0;
  const validateAuth = (token: string | undefined): boolean => {
    if (!authEnabled) return true;
    return token === bearerToken;
  };

  // Register action tools
  const actionTools = generateActionTools(actionRegistry);
  for (const tool of actionTools) {
    const action = actionRegistry.get(tool.name);
    if (!action) continue;

    // Build zod schema for tool parameters
    const zodShape = buildZodShape(action.input);

    // Cast needed: project zod v4 types differ from SDK's bundled zod types
    server.tool(
      tool.name,
      tool.description,
      // biome-ignore lint/suspicious/noExplicitAny: zod v4 vs SDK bundled zod type mismatch
      zodShape as any,
      async (args: Record<string, unknown>) => {
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
      },
    );
  }

  // Register built-in introspection tools
  registerBuiltinTools(
    server,
    schemaRegistry,
    actionRegistry,
    rules,
    states,
    graphqlEndpoint,
    bearerToken,
    tenantId,
  );

  // Register scaffold tools for AI code generation
  registerScaffoldTools(server);

  // Register resources
  registerResources(server, schemaRegistry);

  return { server, validateAuth, authEnabled };
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
        zodType = z.record(z.string(), z.unknown());
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

/** Serialize a RuleDefinition to a JSON-safe object (strip code conditions) */
function serializeRule(rule: RuleDefinition): Record<string, unknown> {
  const serialized: Record<string, unknown> = {
    name: rule.name,
    label: rule.label,
    description: rule.description,
    priority: rule.priority,
    trigger: rule.trigger,
    effect: rule.effect,
  };

  // Serialize condition — code conditions become a placeholder
  if (typeof rule.condition === "function") {
    serialized.condition = { type: "code", description: "Custom code condition" };
  } else {
    serialized.condition = rule.condition;
  }

  return serialized;
}

/**
 * Extract the operation type from a GraphQL query string.
 *
 * Handles bypass vectors like leading comments, fragment definitions before
 * the operation, and named operations. Returns "query", "mutation",
 * "subscription", or "query" as default for shorthand queries like `{ ... }`.
 *
 * Algorithm:
 * 1. Strip all comments (`# ... \n`)
 * 2. Strip all fragment definitions (`fragment Name on Type { ... }`) with balanced braces
 * 3. Trim leading whitespace
 * 4. Check if the remaining text starts with mutation/subscription/query keyword
 */
function extractGraphQLOperationType(query: string): "query" | "mutation" | "subscription" {
  // Step 1: Strip single-line comments (# to end of line)
  let cleaned = query.replace(/#[^\n]*/g, "");

  // Step 2: Strip fragment definitions (fragment Name on Type { ... }) with balanced braces
  // Repeat until no more fragment definitions are found (handles multiple fragments)
  let prev: string;
  do {
    prev = cleaned;
    cleaned = cleaned.replace(/fragment\s+\w+\s+on\s+\w+\s*\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, "");
  } while (cleaned !== prev);

  // Step 3: Trim leading whitespace
  cleaned = cleaned.trim();

  // Step 4: Check the operation type
  const match = cleaned.match(/^(mutation|subscription|query)\b/i);
  if (match) {
    return match[1]?.toLowerCase() as "query" | "mutation" | "subscription";
  }

  // Shorthand query: `{ ... }` with no keyword
  return "query";
}

/** Register built-in introspection tools */
function registerBuiltinTools(
  server: McpServer,
  schemaRegistry: SchemaRegistry,
  actionRegistry: ActionRegistry,
  rules: RuleDefinition[],
  states: StateDefinition[],
  graphqlEndpoint?: string,
  bearerToken?: string,
  tenantId?: string,
): void {
  // list_schemas — returns schema summaries with field names
  server.tool(
    "list_schemas",
    "List all available schemas with their names, labels, descriptions, and field names",
    async () => {
      const schemas = schemaRegistry.getAll().map((s) => ({
        name: s.name,
        label: s.label,
        description: s.description,
        fields: Object.keys(s.fields),
      }));

      return {
        content: [{ type: "text" as const, text: JSON.stringify(schemas, null, 2) }],
      };
    },
  );

  // get_schema — full schema definition with field types and constraints
  const getSchemaShape = { name: z.string().describe("Schema name") };
  server.tool(
    "get_schema",
    "Get the full definition of a schema by name, including all fields with types and constraints",
    // biome-ignore lint/suspicious/noExplicitAny: zod v4 vs SDK bundled zod type mismatch
    getSchemaShape as any,
    async (args: { name: string }) => {
      const schema = schemaRegistry.get(args.name);
      if (!schema) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: `Schema '${args.name}' not found` }),
            },
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

  // list_actions — returns MCP-exposed action summaries with input field names
  server.tool(
    "list_actions",
    "List all MCP-exposed actions with their names, labels, descriptions, schemas, and input field summaries",
    async () => {
      const actions = actionRegistry
        .getAll()
        .filter((a) => {
          // Only show actions exposed to MCP (consistent with tool registration)
          if (a.exposure === undefined || a.exposure === "all") return true;
          return a.exposure.mcp !== false;
        })
        .map((a) => ({
          name: a.name,
          label: a.label,
          description: a.description,
          schema: a.schema,
          inputFields: a.input ? Object.keys(a.input) : [],
        }));

      return {
        content: [{ type: "text" as const, text: JSON.stringify(actions, null, 2) }],
      };
    },
  );

  // get_rules — list rules filtered by schema or action
  const getRulesShape = {
    schema: z.string().describe("Filter rules by schema name").optional(),
    action: z.string().describe("Filter rules by action name").optional(),
  };
  server.tool(
    "get_rules",
    "List business rules, optionally filtered by schema or action name",
    // biome-ignore lint/suspicious/noExplicitAny: zod v4 vs SDK bundled zod type mismatch
    getRulesShape as any,
    async (args: { schema?: string; action?: string }) => {
      let filtered = rules;

      if (args.schema) {
        filtered = filtered.filter((r) => {
          const trigger = r.trigger;
          // Check stateChange trigger for schema match
          if ("stateChange" in trigger && trigger.stateChange.schema === args.schema) return true;
          // Check fieldChange trigger for schema match
          if ("fieldChange" in trigger && trigger.fieldChange.schema === args.schema) return true;
          return false;
        });
      }

      if (args.action) {
        filtered = filtered.filter((r) => {
          const trigger = r.trigger;
          if ("action" in trigger) {
            const actions = Array.isArray(trigger.action) ? trigger.action : [trigger.action];
            return args.action ? actions.includes(args.action) : false;
          }
          return false;
        });
      }

      const serialized = filtered.map(serializeRule);

      return {
        content: [{ type: "text" as const, text: JSON.stringify(serialized, null, 2) }],
      };
    },
  );

  // get_state_machine — get state machine definition for a schema
  const getStateMachineShape = {
    schema: z.string().describe("Schema name to get state machine for"),
  };
  server.tool(
    "get_state_machine",
    "Get the state machine definition for a schema, including states, transitions, and metadata",
    // biome-ignore lint/suspicious/noExplicitAny: zod v4 vs SDK bundled zod type mismatch
    getStateMachineShape as any,
    async (args: { schema: string }) => {
      const matching = states.filter((s) => s.schema === args.schema);

      if (matching.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: `No state machine found for schema '${args.schema}'`,
              }),
            },
          ],
          isError: true,
        };
      }

      // Return all state machines for the schema (usually one, but could be multiple)
      const result = matching.map((sm) => ({
        name: sm.name,
        schema: sm.schema,
        field: sm.field,
        initial: sm.initial,
        states: sm.states,
        transitions: sm.transitions,
        meta: sm.meta,
      }));

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // query — GraphQL proxy tool (read-only: mutations are blocked)
  const queryShape = {
    query: z.string().describe("GraphQL query string (mutations are not allowed)"),
    variables: z.record(z.string(), z.unknown()).describe("GraphQL variables").optional(),
  };
  server.tool(
    "query",
    "Execute a read-only GraphQL query against the LinchKit server. Mutations are blocked — use action tools instead.",
    // biome-ignore lint/suspicious/noExplicitAny: zod v4 vs SDK bundled zod type mismatch
    queryShape as any,
    async (args: { query: string; variables?: Record<string, unknown> }) => {
      if (!graphqlEndpoint) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error:
                  "GraphQL endpoint not configured. Set graphqlEndpoint in MCP adapter options.",
              }),
            },
          ],
          isError: true,
        };
      }

      // Block mutation/subscription operations — MCP writes must go through action tools
      // which pass through the CommandLayer middleware pipeline.
      // We use extractGraphQLOperationType() to robustly detect the operation type even
      // when queries contain leading comments, fragment definitions, or named operations.
      const operationType = extractGraphQLOperationType(args.query);
      if (operationType === "mutation" || operationType === "subscription") {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error:
                  "Mutations and subscriptions are not allowed via the query proxy. " +
                  "Use the corresponding action tools instead, which enforce the full middleware pipeline.",
              }),
            },
          ],
          isError: true,
        };
      }

      try {
        // Forward auth and tenant headers to the GraphQL endpoint
        // to prevent cross-tenant/auth-bypass via the query proxy.
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (bearerToken) {
          headers.Authorization = `Bearer ${bearerToken}`;
        }
        if (tenantId) {
          headers["x-tenant-id"] = tenantId;
        }
        const response = await fetch(graphqlEndpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({
            query: args.query,
            variables: args.variables,
          }),
        });

        if (!response.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: `GraphQL request failed: ${response.status} ${response.statusText}`,
                }),
              },
            ],
            isError: true,
          };
        }

        const data = await response.json();

        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: `GraphQL request error: ${err instanceof Error ? err.message : String(err)}`,
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );
}

/** Register MCP resources */
function registerResources(server: McpServer, schemaRegistry: SchemaRegistry): void {
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
