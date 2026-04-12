/**
 * MCP Server factory
 *
 * Creates an MCP server that exposes LinchKit actions as MCP tools
 * and entities as MCP resources. All action invocations go through
 * the CommandLayer pipeline with channel="mcp".
 *
 * Introspection tools allow AI agents to discover the full system
 * capabilities: entities, actions, rules, state machines, and GraphQL queries.
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
  EntityRegistry,
  OntologyRegistry,
  RuleDefinition,
  StateDefinition,
} from "@linchkit/core";
import type { ProposalEngine } from "@linchkit/core/server";
import type { ExecutionLogger, InsightEngine } from "@linchkit/core/types";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { McpClientRegistry } from "./client-registry";
import { registerExecutionLogTools } from "./execution-log-tools";
import { fieldsToJsonSchema } from "./field-to-json-schema";
import { registerInsightTools } from "./insight-tools";
import { registerManagementTools } from "./management-tools";
import { registerProposalTools } from "./proposal-tools";
import { registerScaffoldTools } from "./scaffold-tools";
import { generateActionTools } from "./tool-registry";
import type { McpClient, ToolPolicy } from "./types";

export interface McpAdapterOptions {
  commandLayer: CommandLayer;
  entityRegistry: EntityRegistry;
  actionRegistry: ActionRegistry;
  ontologyRegistry?: OntologyRegistry;
  /** AI boundary for permission checking */
  aiBoundary?: unknown;
  /** AI audit logger for tracking AI operations */
  aiAuditLogger?: unknown;
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
  /**
   * Client registry for multi-client auth and per-client tool filtering.
   * When provided, resolveActor() uses the registry first, falling back
   * to simple bearerToken comparison for backward compatibility.
   */
  clientRegistry?: McpClientRegistry;
  /**
   * Proposal engine for AI-driven structural change proposals.
   * When provided, registers create_proposal, get_proposal_status, list_proposals tools.
   */
  proposalEngine?: ProposalEngine;
  /**
   * Execution logger for querying action execution history.
   * When provided, registers get_execution_log, get_recent_executions tools.
   */
  executionLogger?: ExecutionLogger;
  /**
   * InsightEngine from the Spec 55 life-system runtime.
   * When provided, registers list_insights tool so MCP clients can read
   * promoted insights (anomalies, friction, patterns, structural, positive).
   */
  insightEngine?: InsightEngine;
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
  /**
   * Resolve an actor from a bearer token.
   * Uses client registry if available, falls back to simple token match.
   * Returns the resolved actor and optional client info.
   */
  resolveActor: (token: string | undefined) => Promise<{
    actor: Actor;
    client?: McpClient;
    toolPolicy?: ToolPolicy;
  } | null>;
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
    entityRegistry,
    actionRegistry,
    rules = [],
    states = [],
    graphqlEndpoint,
    tenantId,
    name = "linchkit",
    version = "1.0.0",
    bearerToken,
    clientRegistry,
    proposalEngine,
    executionLogger,
    insightEngine,
  } = options;

  const server = new McpServer({ name, version });

  // Build auth validator.
  // When no token is configured and no registry, auth is not enforced (open access).
  // When a token is configured, the provided token must match exactly.
  // When a client registry is configured, token is resolved via the registry first.
  const authEnabled =
    clientRegistry !== undefined || (typeof bearerToken === "string" && bearerToken.length > 0);

  const validateAuth = (token: string | undefined): boolean => {
    if (!authEnabled) return true;
    // With client registry, validation happens async via resolveActor.
    // validateAuth is synchronous, so we only do simple bearer check here.
    if (!clientRegistry) return token === bearerToken;
    // When registry is present, accept any non-empty token for sync check.
    // Actual validation happens in resolveActor.
    return token !== undefined && token.length > 0;
  };

  // Actor resolver: tries client registry first, falls back to simple bearer token
  const resolveActor = async (
    token: string | undefined,
  ): Promise<{
    actor: Actor;
    client?: McpClient;
    toolPolicy?: ToolPolicy;
  } | null> => {
    // Try client registry first
    if (clientRegistry && token) {
      const resolved = await clientRegistry.resolveActor(token);
      if (resolved) {
        return {
          actor: resolved.actor,
          client: resolved.client,
          toolPolicy: resolved.client.toolPolicy,
        };
      }
    }

    // Fall back to simple bearer token comparison
    if (bearerToken && token === bearerToken) {
      return { actor: MCP_ACTOR };
    }

    // No auth configured = default actor (open access)
    if (!authEnabled) {
      return { actor: MCP_ACTOR };
    }

    return null;
  };

  // Per-session actor state — set by SSE transport auth before tool calls.
  // For stdio transport, defaults to MCP_ACTOR.
  let sessionActor: Actor = MCP_ACTOR;
  let sessionToolPolicy: ToolPolicy | undefined;

  /**
   * Set the session actor and tool policy (called by SSE transport after auth).
   */
  const setSessionAuth = (actor: Actor, toolPolicy?: ToolPolicy) => {
    sessionActor = actor;
    sessionToolPolicy = toolPolicy;
  };

  // Collect all tool names for filtering
  const allToolNames: Array<{ name: string; category?: string }> = [];

  // Register action tools
  const actionTools = generateActionTools(actionRegistry);
  for (const tool of actionTools) {
    const action = actionRegistry.get(tool.name);
    if (!action) continue;

    allToolNames.push({ name: tool.name, category: "actions" });

    // Build zod shape for tool parameters
    const zodShape = buildZodShape(action.input);

    // Cast needed: project zod v4 types differ from SDK's bundled zod types
    server.tool(
      tool.name,
      tool.description,
      // biome-ignore lint/suspicious/noExplicitAny: zod v4 vs SDK bundled zod type mismatch
      zodShape as any,
      async (args: Record<string, unknown>) => {
        // Defense-in-depth: verify tool is allowed for current session
        if (sessionToolPolicy && clientRegistry) {
          if (!clientRegistry.isToolAllowed(tool.name, sessionToolPolicy, "actions")) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({ error: "Tool not allowed by client policy" }),
                },
              ],
              isError: true,
            };
          }
        }

        const result = await commandLayer.execute({
          command: tool.name,
          input: args as Record<string, unknown>,
          channel: "mcp",
          actor: sessionActor,
          tenantId,
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
    entityRegistry,
    actionRegistry,
    rules,
    states,
    graphqlEndpoint,
    bearerToken,
    tenantId,
  );

  allToolNames.push(
    { name: "list_entities", category: "introspection" },
    { name: "get_entity", category: "introspection" },
    { name: "list_actions", category: "introspection" },
    { name: "get_rules", category: "introspection" },
    { name: "get_state_machine", category: "introspection" },
    { name: "query", category: "query" },
  );

  // Register scaffold tools for AI code generation
  registerScaffoldTools(server);

  // Register management tools if client registry is available
  if (clientRegistry) {
    registerManagementTools(server, clientRegistry);
    allToolNames.push(
      { name: "mcp_list_clients", category: "management" },
      { name: "mcp_create_client", category: "management" },
      { name: "mcp_update_client", category: "management" },
      { name: "mcp_toggle_client", category: "management" },
      { name: "mcp_rotate_secret", category: "management" },
      { name: "mcp_usage_stats", category: "management" },
    );
  }

  // Shared tool policy checker — delegates to clientRegistry.isToolAllowed
  const checkToolPolicy = (toolName: string, category: string) => {
    if (sessionToolPolicy && clientRegistry) {
      if (!clientRegistry.isToolAllowed(toolName, sessionToolPolicy, category)) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: "Tool not allowed by client policy" }),
            },
          ],
          isError: true as const,
        };
      }
    }
    return undefined;
  };

  // Register proposal tools if proposal engine is available
  if (proposalEngine) {
    registerProposalTools(server, proposalEngine, {
      getSessionActor: () => sessionActor,
      checkToolPolicy,
    });
    allToolNames.push(
      { name: "create_proposal", category: "proposals" },
      { name: "get_proposal_status", category: "proposals" },
      { name: "list_proposals", category: "proposals" },
      { name: "approve_proposal", category: "proposals" },
    );
  }

  // Register execution log tools if execution logger is available
  if (executionLogger) {
    registerExecutionLogTools(server, executionLogger, { tenantId, checkToolPolicy });
    allToolNames.push(
      { name: "get_execution_log", category: "observability" },
      { name: "get_recent_executions", category: "observability" },
    );
  }

  // Register insight tools if InsightEngine is available
  if (insightEngine) {
    registerInsightTools(server, insightEngine, { checkToolPolicy });
    allToolNames.push({ name: "list_insights", category: "insight" });
  }

  // Register resources
  registerResources(server, entityRegistry);

  const result: McpAdapterResult & {
    /** Set per-session auth (used by SSE transport after authentication) */
    setSessionAuth: (actor: Actor, toolPolicy?: ToolPolicy) => void;
    /** All registered tool names with categories (for filtering) */
    allToolNames: Array<{ name: string; category?: string }>;
  } = {
    server,
    validateAuth,
    authEnabled,
    resolveActor,
    setSessionAuth,
    allToolNames,
  };

  return result;
}

/** Build a Zod shape from FieldDefinition input record */
function buildZodShape(
  input?: Record<string, import("@linchkit/core").FieldDefinition>,
): Record<string, z.ZodTypeAny> {
  if (!input) return {};

  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [name, field] of Object.entries(input)) {
    // Skip non-input types and secret fields
    if (field.type === "computed" || field.secret) {
      continue;
    }

    let zodType: z.ZodTypeAny;

    switch (field.type) {
      case "string":
      case "text":
      case "date":
      case "datetime":
      case "enum":
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
  entityRegistry: EntityRegistry,
  actionRegistry: ActionRegistry,
  rules: RuleDefinition[],
  states: StateDefinition[],
  graphqlEndpoint?: string,
  bearerToken?: string,
  tenantId?: string,
): void {
  // list_entities — returns entity summaries with field names
  server.tool(
    "list_entities",
    "List all available entities with their names, labels, descriptions, and field names",
    async () => {
      const entities = entityRegistry.getAll().map((s) => ({
        name: s.name,
        label: s.label,
        description: s.description,
        fields: Object.keys(s.fields),
      }));

      return {
        content: [{ type: "text" as const, text: JSON.stringify(entities, null, 2) }],
      };
    },
  );

  // get_entity — full entity definition with field types and constraints
  const getEntityShape = { name: z.string().describe("Entity name") };
  server.tool(
    "get_entity",
    "Get the full definition of an entity by name, including all fields with types and constraints",
    // biome-ignore lint/suspicious/noExplicitAny: zod v4 vs SDK bundled zod type mismatch
    getEntityShape as any,
    async (args: { name: string }) => {
      const entity = entityRegistry.get(args.name);
      if (!entity) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: `Entity '${args.name}' not found` }),
            },
          ],
          isError: true,
        };
      }

      // Convert to a serializable representation with field JSON schemas
      const fieldSchemas = fieldsToJsonSchema(entity.fields);
      const result = {
        name: entity.name,
        label: entity.label,
        description: entity.description,
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
    "List all MCP-exposed actions with their names, labels, descriptions, entities, and input field summaries",
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
          entity: a.entity,
          inputFields: a.input ? Object.keys(a.input) : [],
        }));

      return {
        content: [{ type: "text" as const, text: JSON.stringify(actions, null, 2) }],
      };
    },
  );

  // get_rules — list rules filtered by entity or action
  const getRulesShape = {
    entity: z.string().describe("Filter rules by entity name").optional(),
    action: z.string().describe("Filter rules by action name").optional(),
  };
  server.tool(
    "get_rules",
    "List business rules, optionally filtered by entity or action name",
    // biome-ignore lint/suspicious/noExplicitAny: zod v4 vs SDK bundled zod type mismatch
    getRulesShape as any,
    async (args: { entity?: string; action?: string }) => {
      let filtered = rules;

      if (args.entity) {
        filtered = filtered.filter((r) => {
          const trigger = r.trigger;
          // Check stateChange trigger for entity match
          if ("stateChange" in trigger && trigger.stateChange.entity === args.entity) return true;
          // Check fieldChange trigger for entity match
          if ("fieldChange" in trigger && trigger.fieldChange.entity === args.entity) return true;
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

  // get_state_machine — get state machine definition for an entity
  const getStateMachineShape = {
    entity: z.string().describe("Entity name to get state machine for"),
  };
  server.tool(
    "get_state_machine",
    "Get the state machine definition for an entity, including states, transitions, and metadata",
    // biome-ignore lint/suspicious/noExplicitAny: zod v4 vs SDK bundled zod type mismatch
    getStateMachineShape as any,
    async (args: { entity: string }) => {
      const matching = states.filter((s) => s.entity === args.entity);

      if (matching.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: `No state machine found for entity '${args.entity}'`,
              }),
            },
          ],
          isError: true,
        };
      }

      // Return all state machines for the entity (usually one, but could be multiple)
      const result = matching.map((sm) => ({
        name: sm.name,
        entity: sm.entity,
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
function registerResources(server: McpServer, entityRegistry: EntityRegistry): void {
  server.resource(
    "entities",
    "linchkit://entities",
    { description: "List of all registered entities", mimeType: "application/json" },
    async (uri) => {
      const entities = entityRegistry.getAll().map((s) => ({
        name: s.name,
        label: s.label,
        description: s.description,
      }));

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(entities, null, 2),
          },
        ],
      };
    },
  );
}
