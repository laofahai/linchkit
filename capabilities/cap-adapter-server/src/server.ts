/**
 * Main HTTP server setup — Elysia + graphql-yoga
 *
 * REST action endpoint returns proper HTTP status codes (see spec 16 §2.5).
 * GraphQL endpoint always returns 200 per GraphQL spec.
 */

import { cors } from "@elysiajs/cors";
import type {
  ActionExecutor,
  ActionResult,
  Actor,
  AIService,
  ApprovalEngine,
  ApprovalStatus,
  CapabilityDefinition,
  CommandLayer,
  DataProvider,
  EventBus,
  ExecutionLogger,
  ExecutionStatus,
  FlowDefinition,
  LinchKitConfig,
  PermissionGroupDefinition,
  RuleDefinition,
  SchemaDefinition,
  SchemaRegistry,
  StateDefinition,
  SubscriptionConfig,
  ViewDefinition,
} from "@linchkit/core";
import { createTenantAwareDataProvider } from "@linchkit/core/server";
import type { HealthCheckRegistry, InMemoryMetricsCollector } from "@linchkit/core/server";
import { Elysia } from "elysia";
import type { GraphQLSchema } from "graphql";
import { createYoga } from "graphql-yoga";
import { generateDefaultViews } from "./default-views";
import { createLinkDataLoaders } from "./graphql/link-dataloader";
import { mountProposalAPI } from "./proposal-api";
import {
  SubscriptionManager,
  formatSSEEvent,
  parseSubscriptionQuery,
} from "./subscription-manager";

export interface ServerOptions {
  /** Server port (default: 3001) */
  port?: number;
  /** Server host (default: "localhost") */
  host?: string;
  /** GraphQL endpoint path (default: "/graphql") */
  graphqlPath?: string;
  /** Action executor for REST endpoint */
  executor?: ActionExecutor;
  /** Command layer — if provided, REST actions go through the pipeline */
  commandLayer?: CommandLayer;
  /** Execution logger for log query endpoints */
  executionLogger?: ExecutionLogger;
  /** Schema registry for metadata endpoints */
  schemaRegistry?: SchemaRegistry;
  /** View definitions grouped by schema name */
  views?: Map<string, ViewDefinition[]>;
  /**
   * Resolve tenant ID from a request for GraphQL tenant isolation.
   * Called on each GraphQL request to extract the tenant context.
   * The actor (already verified by auth middleware) is passed so that
   * tenant can be extracted from verified claims instead of raw JWT.
   * Return undefined for no tenant filtering (e.g., admin/system users).
   */
  resolveRequestTenantId?: (request: Request, actor?: Actor) => Promise<string | undefined> | string | undefined;
  /**
   * Resolve the authenticated actor from a request.
   * Called on each GraphQL and REST request to extract the actor context.
   * Return undefined to fall back to the default anonymous actor.
   * Typically implemented by the auth capability (e.g., JWT/session/API-key resolution).
   */
  resolveRequestActor?: (request: Request) => Promise<Actor | undefined> | Actor | undefined;
  /** Loaded capabilities — used for /api/app-config endpoint */
  capabilities?: CapabilityDefinition[];
  /** Data provider for link relation resolvers in GraphQL */
  dataProvider?: DataProvider;
  /**
   * CORS origin configuration.
   * - `string[]`: list of allowed origins
   * - `true`: allow all origins (wildcard)
   * - `false`: disable CORS entirely
   * - `undefined`: defaults to localhost dev origins (ports 3000, 3001)
   */
  cors?: string[] | boolean;
  /** Health check registry for /health endpoint. When provided, runs all registered checks. */
  healthCheckRegistry?: HealthCheckRegistry;
  /** Permission groups for data masking in link resolvers */
  permissionGroups?: PermissionGroupDefinition[];
  /** Schema definitions map for data masking in link resolvers */
  schemaMap?: Map<string, SchemaDefinition>;
  /** Static tenant list for /api/tenants endpoint (used by TenantSwitcher UI) */
  tenants?: Array<{ id: string; name: string }>;
  /** Event bus for SSE subscription endpoint (/api/subscribe) */
  eventBus?: EventBus;
  /** Subscription configuration (heartbeat, limits, etc.) */
  subscriptionConfig?: SubscriptionConfig;
  /** Rule definitions for /api/rules endpoints */
  rules?: RuleDefinition[];
  /** AI service for auto-fill and other AI-powered endpoints */
  aiService?: AIService;
  /** Metrics collector — when provided, /health includes metrics summary */
  metricsCollector?: InMemoryMetricsCollector;
  /** Flow definitions — used by /api/flows endpoints */
  flows?: FlowDefinition[];
  /** State definitions — used by /api/states endpoints */
  states?: StateDefinition[];
  /** LinchKit project config — used by /api/settings (sanitized, no secrets) */
  linchKitConfig?: LinchKitConfig;
  /** Approval engine — when provided, enables /api/approvals REST endpoints */
  approvalEngine?: ApprovalEngine;
}

/** Default anonymous actor for unauthenticated requests. */
const ANONYMOUS_ACTOR: Actor = {
  type: "system",
  id: "anonymous",
  groups: [],
};

/**
 * Map structured error codes to HTTP status codes.
 * Preferred over message-text matching when a code is available.
 */
const ERROR_CODE_STATUS: Record<string, number> = {
  auth: 401,
  "auth.required": 401,
  "auth.credentials.required": 401,
  "auth.token.invalid": 401,
  "auth.token.expired": 401,
  "auth.api_key.invalid": 401,
  "auth.session.invalid": 401,
  authz: 403,
  "authz.action.denied": 403,
  "authz.group_required": 403,
  "exposure.blocked": 403,
  validation: 400,
  "validation.failed": 400,
  "validation.input": 400,
  not_found: 404,
  "not_found.action": 404,
  "not_found.record": 404,
  conflict: 409,
  "conflict.state": 409,
  "conflict.version": 409,
  "rate_limit.exceeded": 429,
  business: 422,
};

/**
 * Map an error code string to HTTP status, supporting both exact and
 * prefix matches (e.g. "PERMISSION.DENIED.FOO" matches "PERMISSION.DENIED").
 */
function mapErrorCodeToStatus(code: string): number | undefined {
  // Exact match first
  if (code in ERROR_CODE_STATUS) return ERROR_CODE_STATUS[code];
  // Prefix match — walk from most specific to least
  const parts = code.split(".");
  for (let i = parts.length - 1; i >= 1; i--) {
    const prefix = parts.slice(0, i).join(".");
    if (prefix in ERROR_CODE_STATUS) return ERROR_CODE_STATUS[prefix];
  }
  return undefined;
}

/**
 * Determine HTTP status code from action result.
 * Checks structured error code first, falls back to message-text matching.
 */
function resolveStatusCode(result: { success: boolean; data?: unknown }): number {
  if (result.success) return 200;

  const errData = result.data as Record<string, unknown> | undefined;

  // Prefer structured error code when available (e.g. from PipelineError)
  const errorCode = typeof errData?.code === "string" ? errData.code : undefined;
  if (errorCode) {
    const codeStatus = mapErrorCodeToStatus(errorCode);
    if (codeStatus !== undefined) return codeStatus;
  }

  // Fallback: match on error message text
  const errorMsg = (errData?.error as string) ?? "";

  // Not found patterns
  if (errorMsg.includes("not found")) return 404;
  // Permission denied patterns
  if (errorMsg.includes("not allowed") || errorMsg.includes("does not belong to")) return 403;
  // Exposure blocked
  if (errorMsg.includes("not exposed")) return 403;
  // Validation failures
  if (errorMsg.includes("validation failed") || errorMsg.includes("Validation failed")) return 400;
  // State transition conflicts and version conflicts
  if (errorMsg.includes("State transition") || errorMsg.includes("State machine")) return 409;
  if (errorMsg.includes("Version conflict")) return 409;

  // Default: 422 for business logic failures
  return 422;
}

/**
 * Parse the primary locale from an Accept-Language header value.
 * Takes the first locale before ',' or ';', normalizing whitespace.
 * Returns undefined if the header is missing or empty.
 */
export function parseAcceptLanguage(header: string | null | undefined): string | undefined {
  if (!header) return undefined;
  // Take the first language tag before ',' or ';'
  const first = header.split(/[,;]/)[0]?.trim();
  return first || undefined;
}

/**
 * Resolve locale from a request: ?locale= query param takes priority over Accept-Language header.
 */
function resolveRequestLocale(request: Request): string | undefined {
  const url = new URL(request.url);
  const queryLocale = url.searchParams.get("locale");
  if (queryLocale) return queryLocale;
  return parseAcceptLanguage(request.headers.get("accept-language"));
}

/**
 * Validate an AI-generated filter: only allow fields that exist in the schema.
 * Recursively walks composite conditions (and/or/not) and strips invalid or sensitive fields.
 * Returns null if the filter is completely invalid after stripping.
 */
function validateAIFilter(
  filter: unknown,
  allowedFields: Set<string>,
  sensitiveFields: Set<string>,
): unknown {
  if (!filter || typeof filter !== "object") return null;

  const f = filter as Record<string, unknown>;
  const operator = f.operator as string | undefined;

  // Composite: and / or
  if (operator === "and" || operator === "or") {
    const conditions = f.conditions;
    if (!Array.isArray(conditions)) return null;
    const validated = conditions
      .map((c) => validateAIFilter(c, allowedFields, sensitiveFields))
      .filter((c) => c !== null);
    if (validated.length === 0) return null;
    if (validated.length === 1) return validated[0];
    return { ...f, conditions: validated };
  }

  // Not
  if (operator === "not") {
    const inner = validateAIFilter(f.condition, allowedFields, sensitiveFields);
    if (!inner) return null;
    return { ...f, condition: inner };
  }

  // Simple condition — validate field name
  const field = f.field as string | undefined;
  if (!field) return null;
  if (sensitiveFields.has(field)) return null;
  if (!allowedFields.has(field)) return null;

  return f;
}

/**
 * Create an Elysia server with GraphQL, health check, and REST action endpoints.
 *
 * @param graphqlSchema - A GraphQL schema built via buildGraphQLSchema()
 * @param options - Server configuration
 */
export function createServer(
  graphqlSchema: GraphQLSchema,
  options?: ServerOptions,
  // biome-ignore lint/suspicious/noExplicitAny: Elysia plugin chaining produces complex inferred types
): any {
  const graphqlPath = options?.graphqlPath ?? "/graphql";
  const executor = options?.executor;
  const commandLayer = options?.commandLayer;
  const executionLogger = options?.executionLogger;
  const schemaRegistry = options?.schemaRegistry;
  const views = options?.views;
  const capabilities = options?.capabilities ?? [];
  const resolveRequestTenantId = options?.resolveRequestTenantId;
  const resolveRequestActor = options?.resolveRequestActor;
  const dataProvider = options?.dataProvider;
  const corsOption = options?.cors;
  const healthCheckRegistry = options?.healthCheckRegistry;
  const permissionGroups = options?.permissionGroups ?? [];
  const schemaMap = options?.schemaMap;
  const tenants = options?.tenants ?? [];
  const rules = options?.rules ?? [];
  const aiService = options?.aiService;
  const metricsCollector = options?.metricsCollector;
  const linchKitConfig = options?.linchKitConfig;
  const approvalEngine = options?.approvalEngine;
  const serverStartedAt = Date.now();

  // Create graphql-yoga instance with actor + tenant context factory
  const yoga = createYoga({
    schema: graphqlSchema,
    graphqlEndpoint: graphqlPath,
    // Landing page serves as GraphQL playground in development
    landingPage: true,
    // Build GraphQL context with actor, tenant isolation, locale, data provider, and masking context for link resolvers
    context: async ({ request }) => {
      const actor = resolveRequestActor
        ? ((await resolveRequestActor(request)) ?? ANONYMOUS_ACTOR)
        : ANONYMOUS_ACTOR;
      const tenantId = resolveRequestTenantId ? await resolveRequestTenantId(request, actor) : undefined;
      const locale = resolveRequestLocale(request);
      // Wrap DataProvider with tenant isolation for this request so all GraphQL
      // resolvers (get, list, link traversal) enforce row-level tenant scoping.
      const scopedProvider = tenantId && dataProvider
        ? createTenantAwareDataProvider(dataProvider, tenantId)
        : dataProvider;
      // Create per-request DataLoaders for batched link resolution (avoids N+1)
      const linkLoaders = scopedProvider ? createLinkDataLoaders(scopedProvider) : undefined;
      return { actor, tenantId, locale, dataProvider: scopedProvider, permissionGroups, schemaMap, linkLoaders };
    },
  });

  // Resolve CORS origin: true → wildcard, false → disabled, string[] → explicit list, default → dev localhost
  const corsOrigin =
    corsOption === true
      ? true
      : corsOption === false
        ? false
        : Array.isArray(corsOption)
          ? corsOption
          : ["http://localhost:3000", "http://localhost:3001"];

  const app = new Elysia()
    .use(
      cors({
        origin: corsOrigin === false ? [] : corsOrigin,
        credentials: false,
      }),
    )
    // Health check — runs all registered probes when HealthCheckRegistry is provided
    .get("/health", async ({ set }) => {
      const system = {
        version: "0.2.0",
        uptime: process.uptime(),
        nodeVersion: process.version,
        platform: process.platform,
        schemaCount: schemaRegistry?.getAll().length ?? 0,
        capabilityCount: capabilities.length,
      };
      if (healthCheckRegistry) {
        const result = await healthCheckRegistry.runAll();
        // Return 503 when any check is unhealthy so load balancers can route away
        if (result.status === "unhealthy") {
          set.status = 503;
        }
        return {
          status: result.status,
          checks: result.checks,
          timestamp: result.timestamp,
          system,
        };
      }
      // Fallback: basic liveness response when no registry is configured
      return {
        status: "healthy",
        checks: [],
        timestamp: new Date().toISOString(),
        system,
      };
    })
    // Metrics summary endpoint — returns aggregated metrics from the collector
    .get("/api/metrics", () => {
      if (!metricsCollector) {
        return { success: false, error: "No metrics collector configured" };
      }
      return {
        success: true,
        data: metricsCollector.getSummary(),
        timestamp: new Date().toISOString(),
      };
    })
    // App config — tells the UI which capabilities are loaded and their pages
    .get("/api/app-config", () => {
      const authEnabled = capabilities.some((c) => c.name === "cap-auth");
      const aiEnabled = !!aiService?.configured;
      const pages = capabilities.flatMap((c) => c.pages ?? []);
      return {
        success: true,
        data: {
          authEnabled,
          aiEnabled,
          capabilities: capabilities.map((c) => c.name),
          pages,
        },
      };
    })
    // Tenant list — consumed by TenantSwitcher UI component
    .get("/api/tenants", () => {
      return { success: true, data: tenants };
    })
    // Settings — sanitized system configuration for admin UI
    .get("/api/settings", () => {
      const cfg = linchKitConfig;
      const uptimeMs = Date.now() - serverStartedAt;
      const actionCount = capabilities.reduce(
        (sum, c) => sum + (c.actions?.length ?? 0),
        0,
      );

      // Sanitize: never expose secrets, tokens, passwords, connection URLs
      const settings = {
        general: {
          version: "0.2.0",
          uptime: uptimeMs,
          registeredSchemas: schemaRegistry?.getAll().length ?? 0,
          registeredActions: actionCount,
          registeredRules: rules.length,
          registeredFlows: options?.flows?.length ?? 0,
          registeredStates: options?.states?.length ?? 0,
          capabilityCount: capabilities.length,
          capabilities: capabilities.map((c) => c.name),
        },
        database: {
          configured: !!cfg?.database?.url,
          provider: cfg?.database?.url ? "postgresql" : "in-memory",
          poolSize: cfg?.database?.poolSize ?? 10,
          debug: cfg?.database?.debug ?? false,
        },
        ai: {
          configured: !!aiService?.configured,
          defaultProvider: cfg?.ai?.defaultProvider ?? null,
          providers: cfg?.ai?.providers
            ? Object.keys(cfg.ai.providers)
            : [],
        },
        auth: {
          enabled: capabilities.some((c) => c.name === "cap-auth"),
          provider: capabilities.find((c) => c.name.startsWith("cap-auth-"))?.name ?? null,
        },
        tenancy: {
          mode: tenants.length > 0 ? "multi" : "standalone",
          tenantCount: tenants.length,
        },
        server: {
          port: cfg?.server?.port ?? 3001,
          host: cfg?.server?.host ?? "localhost",
        },
        subscription: {
          enabled: cfg?.subscription?.enabled ?? true,
          maxConnectionsPerUser: cfg?.subscription?.maxConnectionsPerUser ?? 3,
          heartbeatInterval: cfg?.subscription?.heartbeatInterval ?? 30000,
          idleTimeout: cfg?.subscription?.idleTimeout ?? 300000,
          maxBufferSize: cfg?.subscription?.maxBufferSize ?? 100,
        },
        flow: {
          configured: !!cfg?.flow,
          engine: cfg?.flow?.restate ? "restate" : "sync",
        },
      };

      return { success: true, data: settings };
    })
    // Rule definition endpoints — consumed by Rules management UI
    .get("/api/rules", ({ query }) => {
      let filtered = rules;
      if (query.schema && typeof query.schema === "string") {
        const schemaFilter = query.schema;
        filtered = filtered.filter((r) => {
          const trigger = r.trigger;
          if ("stateChange" in trigger) return trigger.stateChange.schema === schemaFilter;
          if ("fieldChange" in trigger) return trigger.fieldChange.schema === schemaFilter;
          if ("action" in trigger) {
            const actions = Array.isArray(trigger.action) ? trigger.action : [trigger.action];
            return actions.some((a) => a.includes(schemaFilter));
          }
          return false;
        });
      }
      if (query.triggerType && typeof query.triggerType === "string") {
        const tt = query.triggerType;
        filtered = filtered.filter((r) => {
          const trigger = r.trigger;
          if (tt === "action") return "action" in trigger;
          if (tt === "stateChange") return "stateChange" in trigger;
          if (tt === "fieldChange") return "fieldChange" in trigger;
          if (tt === "event") return "event" in trigger;
          if (tt === "schedule") return "schedule" in trigger;
          return true;
        });
      }
      const serialized = filtered.map((r) => ({
        name: r.name,
        label: r.label,
        description: r.description,
        priority: r.priority ?? 0,
        trigger: r.trigger,
        condition: typeof r.condition === "function" ? { type: "code" } : r.condition,
        effect: r.effect,
      }));
      return { success: true, data: serialized };
    })
    .get("/api/rules/:name", ({ params, set }) => {
      const rule = rules.find((r) => r.name === params.name);
      if (!rule) {
        set.status = 404;
        return { success: false, error: { message: `Rule "${params.name}" not found.` } };
      }
      return {
        success: true,
        data: {
          name: rule.name,
          label: rule.label,
          description: rule.description,
          priority: rule.priority ?? 0,
          trigger: rule.trigger,
          condition: typeof rule.condition === "function" ? { type: "code" } : rule.condition,
          effect: rule.effect,
        },
      };
    })
    // Schema metadata endpoints
    .get("/api/schemas", () => {
      if (!schemaRegistry) {
        return { success: true, data: [] };
      }
      // Lightweight list — name/label/description/icon for navigation
      const schemas = schemaRegistry.getAll().map((s) => ({
        name: s.name,
        label: s.label,
        description: s.description,
        icon: s.presentation?.icon,
      }));
      return { success: true, data: schemas };
    })
    .get("/api/schemas/:name", ({ params, set }) => {
      if (!schemaRegistry) {
        set.status = 404;
        return { success: false, error: { message: "Schema registry not configured." } };
      }
      const schema = schemaRegistry.get(params.name);
      if (!schema) {
        set.status = 404;
        return { success: false, error: { message: `Schema "${params.name}" not found.` } };
      }
      // Bundle schema + views + state machines in one response
      const schemaViews = views?.get(params.name) ?? [];
      const viewsMap: Record<string, unknown> = {};
      for (const v of schemaViews) {
        viewsMap[v.name] = v;
      }
      // Generate default views when none are explicitly defined
      if (Object.keys(viewsMap).length === 0) {
        const defaults = generateDefaultViews(schema);
        for (const [k, v] of Object.entries(defaults)) {
          viewsMap[k] = v;
        }
      }
      // Collect all state machines that belong to this schema from all capabilities
      const schemaStates = capabilities.flatMap((cap) =>
        (cap.states ?? []).filter((s) => s.schema === params.name),
      );
      // Collect all links related to this schema (from or to)
      const schemaLinks = capabilities.flatMap((cap) =>
        (cap.links ?? []).filter((l) => l.from === params.name || l.to === params.name),
      );
      return { success: true, data: { ...schema, views: viewsMap, states: schemaStates, links: schemaLinks } };
    })
    // REST action endpoint — executes via ActionExecutor
    // Body is unwrapped action input (Stripe-style, see spec 16 §2.4)
    .post("/api/actions/:name", async ({ params, body, set, request }) => {
      if (!executor && !commandLayer) {
        set.status = 500;
        return {
          success: false,
          error: {
            code: "SYSTEM.SERVER.NOT_CONFIGURED",
            type: "system",
            message: "Action executor not configured.",
          },
        };
      }

      const input = (body as Record<string, unknown>) ?? {};

      // Resolve locale and actor from request
      const locale = resolveRequestLocale(request);
      const actor = resolveRequestActor
        ? ((await resolveRequestActor(request)) ?? ANONYMOUS_ACTOR)
        : ANONYMOUS_ACTOR;

      // Use CommandLayer pipeline when available, otherwise direct executor
      let result: ActionResult;
      if (commandLayer) {
        // Extract headers for middleware use
        const headers: Record<string, string> = {};
        for (const [key, value] of request.headers.entries()) {
          headers[key] = value;
        }
        result = await commandLayer.execute({
          command: params.name,
          input,
          actor,
          channel: "http",
          locale,
          headers,
        });
      } else {
        if (!executor) {
          set.status = 500;
          return {
            success: false,
            error: {
              code: "SYSTEM.SERVER.NOT_CONFIGURED",
              type: "system",
              message: "Action executor not configured.",
            },
          };
        }
        result = await executor.execute(params.name, input, actor, {
          channel: "http",
          locale,
        });
      }

      if (result.success) {
        return {
          success: true,
          data: result.data,
          meta: { executionId: result.executionId },
        };
      }

      set.status = resolveStatusCode(result);
      const errData = result.data as Record<string, unknown> | undefined;
      const rawMessage = (errData?.error as string) ?? "Action execution failed";

      // In production, sanitize internal error details to prevent information leakage
      const isDevMode = process.env.NODE_ENV !== "production";
      const safeMessage = isDevMode ? rawMessage : "Action execution failed";

      return {
        success: false,
        error: {
          code: "ACTION.EXECUTION.FAILED",
          message: safeMessage,
          ...(isDevMode && errData?.details ? { details: errData.details } : {}),
        },
        meta: { executionId: result.executionId },
      };
    })
    // ── Data Import endpoint ────────────────────────────────
    // Accepts multipart form data with a JSON/CSV file, creates records via CommandLayer
    .post("/api/schemas/:name/import", async ({ params, request, set }) => {
      if (!commandLayer && !executor) {
        set.status = 500;
        return { success: false, error: { message: "Action executor not configured." } };
      }

      if (!schemaRegistry) {
        set.status = 500;
        return { success: false, error: { message: "Schema registry not configured." } };
      }

      const schema = schemaRegistry.get(params.name);
      if (!schema) {
        set.status = 404;
        return { success: false, error: { message: `Schema "${params.name}" not found.` } };
      }

      // Resolve actor
      const actor = resolveRequestActor
        ? ((await resolveRequestActor(request)) ?? ANONYMOUS_ACTOR)
        : ANONYMOUS_ACTOR;
      const locale = resolveRequestLocale(request);

      try {
        // Parse multipart form data
        const formData = await request.formData();
        const file = formData.get("file") as File | null;
        const format = (formData.get("format") as string) ?? "json";

        if (!file) {
          set.status = 400;
          return { success: false, error: { message: "No file provided." } };
        }

        const content = await file.text();
        let records: Record<string, unknown>[];

        if (format === "csv") {
          // Parse CSV
          const lines = content.split(/\r?\n/).filter((l: string) => l.trim().length > 0);
          if (lines.length < 2) {
            set.status = 400;
            return { success: false, error: { message: "CSV file must have a header row and at least one data row." } };
          }
          const headerLine = lines[0]!;
          const headers = headerLine.split(",").map((h: string) => h.trim());
          records = [];
          for (let i = 1; i < lines.length; i++) {
            const values = lines[i]!.split(",");
            const record: Record<string, unknown> = {};
            for (let j = 0; j < headers.length; j++) {
              record[headers[j]!] = values[j]?.trim() ?? "";
            }
            records.push(record);
          }
        } else {
          // Parse JSON
          const parsed = JSON.parse(content);
          records = Array.isArray(parsed) ? parsed : [parsed];
        }

        // Import records one by one through the action pipeline
        let imported = 0;
        const errors: Array<{ row: number; error: string }> = [];
        const createActionName = `create_${params.name}`;

        for (let i = 0; i < records.length; i++) {
          try {
            const input = records[i]!;
            if (commandLayer) {
              const result = await commandLayer.execute({
                command: createActionName,
                input,
                actor,
                channel: "http",
                locale,
              });
              if (!result.success) {
                const errData = result.data as Record<string, unknown> | undefined;
                const msg = (errData?.error as string) ?? "Import failed";
                errors.push({ row: i + 1, error: msg });
                continue;
              }
            } else if (executor) {
              const result = await executor.execute(createActionName, input, actor, {
                channel: "http",
                locale,
              });
              if (!result.success) {
                const errData = result.data as Record<string, unknown> | undefined;
                const msg = (errData?.error as string) ?? "Import failed";
                errors.push({ row: i + 1, error: msg });
                continue;
              }
            }
            imported++;
          } catch (err) {
            errors.push({
              row: i + 1,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        return {
          success: true,
          data: { imported, errors },
        };
      } catch (err) {
        set.status = 400;
        return {
          success: false,
          error: {
            message: err instanceof Error ? err.message : "Failed to process import file.",
          },
        };
      }
    })
    // ── Execution Log REST endpoints ────────────────────────
    .get("/api/executions", async ({ query, set }) => {
      if (!executionLogger) {
        set.status = 500;
        return { success: false, error: { message: "Execution logger not configured." } };
      }

      // Validate date parameters
      const ISO_DATE_RE =
        /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;
      if (query.since && !ISO_DATE_RE.test(query.since as string)) {
        set.status = 400;
        return { success: false, error: { message: "Invalid 'since' date format." } };
      }
      if (query.until && !ISO_DATE_RE.test(query.until as string)) {
        set.status = 400;
        return { success: false, error: { message: "Invalid 'until' date format." } };
      }

      // Validate and clamp pagination
      let page = query.page ? Number(query.page) : undefined;
      let pageSize = query.pageSize ? Number(query.pageSize) : undefined;
      if (page !== undefined) {
        if (Number.isNaN(page)) {
          set.status = 400;
          return { success: false, error: { message: "Invalid 'page' parameter." } };
        }
        page = Math.max(1, Math.floor(page));
      }
      if (pageSize !== undefined) {
        if (Number.isNaN(pageSize)) {
          set.status = 400;
          return { success: false, error: { message: "Invalid 'pageSize' parameter." } };
        }
        pageSize = Math.max(1, Math.min(100, Math.floor(pageSize)));
      }

      try {
        const result = await executionLogger.findMany({
          action: query.action as string | undefined,
          schema: query.schema as string | undefined,
          status: query.status as ExecutionStatus | undefined,
          actorId: query.actorId as string | undefined,
          since: query.since as string | undefined,
          until: query.until as string | undefined,
          page,
          pageSize,
          sortField: query.sortField as "startedAt" | "duration" | "action" | undefined,
          sortOrder: query.sortOrder as "asc" | "desc" | undefined,
        });
        return { success: true, data: result };
      } catch (err) {
        set.status = 500;
        const message =
          process.env.NODE_ENV === "production"
            ? "Failed to query execution logs."
            : err instanceof Error
              ? err.message
              : String(err);
        return { success: false, error: { message } };
      }
    })
    .get("/api/executions/:id", async ({ params, set }) => {
      if (!executionLogger) {
        set.status = 500;
        return { success: false, error: { message: "Execution logger not configured." } };
      }
      const entry = await executionLogger.getById(params.id);
      if (!entry) {
        set.status = 404;
        return { success: false, error: { message: `Execution ${params.id} not found.` } };
      }
      return { success: true, data: entry };
    })
    // ── Approval REST endpoints ──────────────────────────
    .get("/api/approvals", async ({ request, query, set }) => {
      if (!approvalEngine) {
        set.status = 501;
        return { success: false, error: { message: "Approval engine not configured." } };
      }
      const actor = resolveRequestActor
        ? ((await resolveRequestActor(request)) ?? ANONYMOUS_ACTOR)
        : ANONYMOUS_ACTOR;

      const statusFilter = query.status as ApprovalStatus | undefined;
      const requests = await approvalEngine.store.query({
        status: statusFilter ?? "pending",
        tenantId: resolveRequestTenantId
          ? (await resolveRequestTenantId(request, actor)) ?? undefined
          : undefined,
      });
      return { success: true, data: { items: requests, total: requests.length } };
    })
    .get("/api/approvals/count", async ({ request, set }) => {
      if (!approvalEngine) {
        return { success: true, data: { count: 0 } };
      }
      const actor = resolveRequestActor
        ? ((await resolveRequestActor(request)) ?? ANONYMOUS_ACTOR)
        : ANONYMOUS_ACTOR;
      const requests = await approvalEngine.store.query({
        status: "pending",
        tenantId: resolveRequestTenantId
          ? (await resolveRequestTenantId(request, actor)) ?? undefined
          : undefined,
      });
      return { success: true, data: { count: requests.length } };
    })
    .get("/api/approvals/:id", async ({ params, set }) => {
      if (!approvalEngine) {
        set.status = 501;
        return { success: false, error: { message: "Approval engine not configured." } };
      }
      const request = await approvalEngine.store.getById(params.id);
      if (!request) {
        set.status = 404;
        return { success: false, error: { message: `Approval ${params.id} not found.` } };
      }
      return { success: true, data: request };
    })
    .post("/api/approvals/:id/approve", async ({ params, body, request, set }) => {
      if (!approvalEngine) {
        set.status = 501;
        return { success: false, error: { message: "Approval engine not configured." } };
      }
      const actor = resolveRequestActor
        ? ((await resolveRequestActor(request)) ?? ANONYMOUS_ACTOR)
        : ANONYMOUS_ACTOR;
      const { note } = (body ?? {}) as { note?: string };
      try {
        const result = await approvalEngine.approve(
          { approvalId: params.id, note },
          actor,
        );
        return { success: true, data: result };
      } catch (err) {
        set.status = 400;
        return {
          success: false,
          error: { message: err instanceof Error ? err.message : String(err) },
        };
      }
    })
    .post("/api/approvals/:id/reject", async ({ params, body, request, set }) => {
      if (!approvalEngine) {
        set.status = 501;
        return { success: false, error: { message: "Approval engine not configured." } };
      }
      const actor = resolveRequestActor
        ? ((await resolveRequestActor(request)) ?? ANONYMOUS_ACTOR)
        : ANONYMOUS_ACTOR;
      const { note } = (body ?? {}) as { note?: string };
      if (!note || note.trim() === "") {
        set.status = 400;
        return { success: false, error: { message: "Rejection note is required." } };
      }
      try {
        const result = await approvalEngine.reject(
          { approvalId: params.id, note },
          actor,
        );
        return { success: true, data: result };
      } catch (err) {
        set.status = 400;
        return {
          success: false,
          error: { message: err instanceof Error ? err.message : String(err) },
        };
      }
    })
    // ── AI Auto-Fill endpoint ────────────────────────────
    .post("/api/ai/auto-fill", async ({ body, set }) => {
      const { schema: schemaName, fields, currentValues } = (body ?? {}) as {
        schema?: string;
        fields?: Record<string, { label?: string; type?: string; required?: boolean; options?: string[]; description?: string }>;
        currentValues?: Record<string, unknown>;
      };

      // Always validate required fields first, before checking AI availability
      if (!schemaName || !fields) {
        set.status = 400;
        return { success: false, error: { message: "Missing 'schema' or 'fields' in request body." } };
      }

      if (!aiService?.configured) {
        return { success: true, data: { suggestions: {} } };
      }

      try {
        // Build field descriptions for the prompt
        const fieldDescriptions = Object.entries(fields).map(([name, def]) => {
          const parts = [`- ${name}`];
          if (def.label) parts.push(`(label: "${def.label}")`);
          if (def.type) parts.push(`[type: ${def.type}]`);
          if (def.required) parts.push("(required)");
          if (def.options?.length) parts.push(`options: [${def.options.join(", ")}]`);
          if (def.description) parts.push(`— ${def.description}`);
          return parts.join(" ");
        }).join("\n");

        // Identify which fields already have values
        const filledFields = currentValues
          ? Object.entries(currentValues)
              .filter(([, v]) => v !== null && v !== undefined && v !== "")
              .map(([k, v]) => `- ${k}: ${JSON.stringify(v)}`)
              .join("\n")
          : "None";

        // Identify empty fields that need suggestions
        const emptyFieldNames = Object.keys(fields).filter((name) => {
          const val = currentValues?.[name];
          return val === null || val === undefined || val === "";
        });

        if (emptyFieldNames.length === 0) {
          return { success: true, data: { suggestions: {} } };
        }

        const prompt = `You are a form auto-fill assistant for a "${schemaName}" record.

Given the schema fields and any already-filled values, suggest realistic values for the empty fields.

Schema fields:
${fieldDescriptions}

Already filled:
${filledFields}

Empty fields that need suggestions: ${emptyFieldNames.join(", ")}

Respond with a JSON object where each key is a field name and the value is an object with:
- "value": the suggested value (matching the field type)
- "confidence": a number 0-1 indicating how confident you are
- "reason": a brief explanation of why you suggested this value

Only suggest values for the empty fields listed above. For enum/state fields, only use values from the provided options. For number fields, provide a number. For boolean fields, provide true/false. For date fields, provide an ISO date string.`;

        const result = await aiService.complete({
          model: "fast",
          messages: [
            { role: "system", content: "You are a helpful assistant that fills form fields with realistic, contextually appropriate values. Always respond with valid JSON only, no markdown formatting." },
            { role: "user", content: prompt },
          ],
          temperature: 0.3,
          maxTokens: 2000,
          timeout: 30000,
        });

        // Parse AI response
        let suggestions: Record<string, { value: unknown; confidence: number; reason?: string }> = {};
        try {
          // Strip markdown code fences if present
          let content = result.content.trim();
          if (content.startsWith("```")) {
            content = content.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
          }
          suggestions = JSON.parse(content);
        } catch {
          // If parsing fails, return empty suggestions
          return { success: true, data: { suggestions: {} } };
        }

        return { success: true, data: { suggestions } };
      } catch (err) {
        const message = process.env.NODE_ENV === "production"
          ? "AI auto-fill failed."
          : err instanceof Error ? err.message : String(err);
        set.status = 500;
        return { success: false, error: { message } };
      }
    })
    // ── AI Chat endpoint ──────────────────────────────────
    .post("/api/ai/chat", async ({ body, set }) => {
      const { message, context } = (body ?? {}) as {
        message?: string;
        context?: { schema?: string; recordId?: string };
      };

      if (!message || typeof message !== "string") {
        set.status = 400;
        return { success: false, error: { message: "message is required" } };
      }

      if (!aiService?.configured) {
        return {
          success: true,
          data: {
            reply:
              "AI service is not configured. Configure an AI provider in linchkit.config.ts to enable the assistant.",
            suggestions: [],
          },
        };
      }

      // Build system prompt with schema context
      let systemPrompt =
        "You are LinchKit AI Assistant. Help users understand their data, suggest actions, " +
        "and answer questions. Be concise and helpful. " +
        "When you want to suggest actions the user can take, include them in your response as " +
        'a JSON block at the very end: <!-- suggestions:[{"action":"action_name","label":"Button Label"}] -->';

      if (context?.schema && schemaRegistry) {
        const schema = schemaRegistry.get(context.schema);
        if (schema) {
          systemPrompt += `\n\nCurrent schema context: ${schema.name}`;
          if (schema.label) systemPrompt += ` (${schema.label})`;
          systemPrompt += `\nFields: ${Object.keys(schema.fields).join(", ")}`;
          if (context.recordId) {
            systemPrompt += `\nViewing record ID: ${context.recordId}`;
          }
        }
      }

      try {
        const result = await aiService.complete({
          model: "fast",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: message },
          ],
          temperature: 0.3,
          maxTokens: 1024,
          timeout: 30_000,
        });

        // Extract suggestions from the response if present
        let reply = result.content;
        let suggestions: Array<{ action: string; label: string }> = [];
        const suggestionsMatch = reply.match(
          /<!-- suggestions:(\[.*?\]) -->/s,
        );
        if (suggestionsMatch?.[1]) {
          try {
            suggestions = JSON.parse(suggestionsMatch[1]);
          } catch {
            // Ignore parse errors for suggestions
          }
          reply = reply.replace(/<!-- suggestions:\[.*?\] -->/s, "").trim();
        }

        return {
          success: true,
          data: { reply, suggestions },
        };
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : "AI request failed";
        set.status = 500;
        return {
          success: false,
          error: { message: errorMessage },
        };
      }
    })
    // ── AI Search endpoint — natural language to DeclarativeCondition ──
    .post("/api/ai/search", async ({ body, set }) => {
      const { query: rawQuery, schema: targetSchema, fields } = (body ?? {}) as {
        query?: string;
        schema?: string;
        fields?: Record<string, { label?: string; type?: string; options?: string[] }>;
      };

      if (!rawQuery || !targetSchema) {
        set.status = 400;
        return { success: false, error: { message: "Missing 'query' or 'schema' in request body." } };
      }

      if (!aiService?.configured) {
        return { success: true, data: null };
      }

      // Sanitize query: strip control characters, limit length, escape quotes
      const sanitizedQuery = rawQuery
        .replace(/[\x00-\x1f\x7f]/g, "") // strip control characters
        .slice(0, 500) // limit length
        .replace(/"/g, '\\"'); // escape quotes

      // Build allowed field names set (schema fields + system fields)
      const SYSTEM_FIELDS = new Set(["id", "tenant_id", "created_at", "updated_at", "created_by", "updated_by", "_version"]);
      const SENSITIVE_FIELDS = new Set(["_password", "password", "secret", "token", "tenant_id"]);
      const allowedFields = new Set([
        ...Object.keys(fields ?? {}),
        ...SYSTEM_FIELDS,
      ]);

      try {
        const fieldDescs = Object.entries(fields ?? {}).map(([name, def]) => {
          const parts = [`- ${name}`];
          if (def.label) parts.push(`(label: "${def.label}")`);
          if (def.type) parts.push(`[type: ${def.type}]`);
          if (def.options?.length) parts.push(`options: [${def.options.join(", ")}]`);
          return parts.join(" ");
        }).join("\n");

        const prompt = [
          `You are a search filter parser for a "${targetSchema}" data model.`,
          "",
          "Convert the following natural language search query into a structured filter condition.",
          "",
          "Available fields:",
          fieldDescs,
          "",
          "Available operators: eq, neq, gt, gte, lt, lte, in, not_in, contains, between, startsWith, endsWith, is_null, not_null",
          "",
          `Query: "${sanitizedQuery}"`,
          "",
          'Respond with valid JSON only (no markdown, no code fences). The response must have this exact shape:',
          '{ "filter": <condition>, "explanation": "<brief explanation>" }',
          "",
          "Filter condition formats:",
          '- Simple: { "field": "fieldName", "operator": "eq", "value": "someValue" }',
          '- Composite: { "operator": "and", "conditions": [<condition>, ...] }',
          '- For "between": { "field": "fieldName", "operator": "between", "value": [low, high] }',
          '- For "in": { "field": "fieldName", "operator": "in", "value": ["a", "b"] }',
          "",
          "Rules:",
          "- Match field names exactly from the available fields list",
          "- For enum/state fields, use the option values from the list",
          "- For number comparisons, use numeric values (not strings)",
          "- For date fields, use ISO date strings",
          "- If the query references a field label (Chinese or English), map it to the field name",
          '- If the query cannot be parsed into a filter, return { "filter": null, "explanation": "..." }',
        ].join("\n");

        const result = await aiService.complete({
          model: "fast",
          messages: [
            { role: "system", content: "You are a precise query parser. Only output valid JSON. No markdown formatting." },
            { role: "user", content: prompt },
          ],
          temperature: 0,
          maxTokens: 1024,
          timeout: 15000,
        });

        let aiContent = result.content.trim();
        if (aiContent.startsWith("```")) {
          aiContent = aiContent.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
        }

        const parsed = JSON.parse(aiContent) as { filter: unknown; explanation: string };

        if (!parsed.filter) {
          return { success: true, data: null };
        }

        // Validate AI-generated filter: strip fields not in schema or sensitive fields
        const validatedFilter = validateAIFilter(parsed.filter, allowedFields, SENSITIVE_FIELDS);

        return {
          success: true,
          data: { filter: validatedFilter, explanation: parsed.explanation ?? "" },
        };
      } catch (err) {
        const errMsg = process.env.NODE_ENV === "production"
          ? "AI search parsing failed."
          : err instanceof Error ? err.message : String(err);
        set.status = 500;
        return { success: false, error: { message: errMsg } };
      }
    })
    // Mount graphql-yoga — handle all methods on the graphql path
    .all(graphqlPath, async ({ request }) => {
      const response = await yoga.handle(request);
      return response;
    })
    // ── Flow REST endpoints ──────────────────────────────────
    .get("/api/flows", () => {
      // Collect flows from options or capabilities
      const allFlows: FlowDefinition[] = options?.flows ?? [];
      if (!allFlows.length && capabilities.length > 0) {
        for (const cap of capabilities) {
          if (cap.flows) allFlows.push(...cap.flows);
        }
      }
      const summary = allFlows.map((f) => ({
        name: f.name,
        label: f.label,
        description: f.description,
        version: f.version,
        trigger: f.trigger,
        stepCount: f.steps.length,
        steps: f.steps.map((s) => ({ id: s.id, name: s.name, type: s.type })),
      }));
      return { success: true, data: summary };
    })
    .get("/api/flows/:name", ({ params, set }) => {
      const allFlows: FlowDefinition[] = options?.flows ?? [];
      if (!allFlows.length && capabilities.length > 0) {
        for (const cap of capabilities) {
          if (cap.flows) allFlows.push(...cap.flows);
        }
      }
      const flow = allFlows.find((f) => f.name === params.name);
      if (!flow) {
        set.status = 404;
        return { success: false, error: { message: `Flow "${params.name}" not found.` } };
      }
      return { success: true, data: flow };
    })
    // ── State Machine REST endpoints ─────────────────────────
    .get("/api/states", () => {
      const allStates: StateDefinition[] = options?.states ?? [];
      if (!allStates.length && capabilities.length > 0) {
        for (const cap of capabilities) {
          if (cap.states) allStates.push(...cap.states);
        }
      }
      const summary = allStates.map((s) => ({
        name: s.name,
        schema: s.schema,
        field: s.field,
        initial: s.initial,
        stateCount: s.states.length,
        transitionCount: s.transitions.length,
        states: s.states,
        meta: s.meta,
      }));
      return { success: true, data: summary };
    })
    .get("/api/states/:name", ({ params, set }) => {
      const allStates: StateDefinition[] = options?.states ?? [];
      if (!allStates.length && capabilities.length > 0) {
        for (const cap of capabilities) {
          if (cap.states) allStates.push(...cap.states);
        }
      }
      const state = allStates.find((s) => s.name === params.name);
      if (!state) {
        set.status = 404;
        return { success: false, error: { message: `State machine "${params.name}" not found.` } };
      }
      return { success: true, data: state };
    });

  // ── Proposal / Evolution / AI Insights endpoints ──────────
  mountProposalAPI(app, executionLogger);

  // ── SSE Subscription endpoint (/api/subscribe) ────────────
  const eventBus = options?.eventBus;
  const subscriptionConfig = options?.subscriptionConfig;

  if (eventBus) {
    const subManager = new SubscriptionManager(eventBus, subscriptionConfig);

    // Wire permission checker: verify the actor can read the schema before delivering events.
    // Check schema exposure config — if GraphQL is explicitly disabled, deny SSE events too.
    if (schemaRegistry) {
      const permGroups = options?.permissionGroups;
      subManager.setPermissionChecker((actor, schemaName) => {
        const schemaDef = schemaRegistry.get(schemaName);
        if (!schemaDef) return false; // Unknown schema — deny
        // If exposure is configured and graphql is explicitly false, deny
        if (schemaDef.exposure?.graphql === false) return false;
        // Basic RBAC: if permission groups are configured, check actor has read access
        if (permGroups && actor && actor.type !== "system") {
          const actorGroups = new Set(actor.groups ?? []);
          // Find if any permission group grants read access to this schema for the actor's groups.
          // Permission structure: permissions[capabilityName][schemaName].data.read
          const hasReadPermission = permGroups.some((pg) => {
            if (!actorGroups.has(pg.name)) return false;
            // Search across all capabilities for this schema
            for (const capPerms of Object.values(pg.permissions ?? {})) {
              const schemaPerms = capPerms[schemaName];
              if (schemaPerms?.data?.read && schemaPerms.data.read !== "none") return true;
            }
            return false;
          });
          // If permission groups exist but none grant read, deny (unless actor has no groups — allow for backward compat)
          if (actorGroups.size > 0 && !hasReadPermission) return false;
        }
        return true;
      });
    }

    subManager.start();

    app.get("/api/subscribe", async ({ request, set, query }) => {
      // Resolve actor for permission filtering
      const actor = resolveRequestActor
        ? ((await resolveRequestActor(request)) ?? ANONYMOUS_ACTOR)
        : ANONYMOUS_ACTOR;
      const tenantId = resolveRequestTenantId
        ? await resolveRequestTenantId(request, actor)
        : undefined;

      // Parse filter from query params
      const filter = parseSubscriptionQuery(query as Record<string, string | undefined>);
      filter.tenantId = tenantId;

      // Set up SSE response via ReadableStream
      let connectionId: string | null = null;

      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();

          const push = (event: import("./subscription-manager").SubscriptionEvent | null): boolean => {
            try {
              const eventId = subManager.nextEventId();
              const text = formatSSEEvent(event, event ? eventId : undefined);
              controller.enqueue(encoder.encode(text));
              return true;
            } catch {
              return false;
            }
          };

          const close = () => {
            try {
              controller.close();
            } catch {
              // Already closed
            }
          };

          connectionId = subManager.addConnection({
            userId: actor.id,
            actor,
            filter,
            push,
            close,
          });

          if (!connectionId) {
            // Too many connections for this user
            controller.enqueue(
              encoder.encode(
                `event: error\ndata: ${JSON.stringify({ error: "Too many connections" })}\n\n`,
              ),
            );
            controller.close();
            return;
          }

          // Send initial connection event
          controller.enqueue(
            encoder.encode(
              `event: connected\ndata: ${JSON.stringify({ connectionId })}\n\n`,
            ),
          );
        },
        cancel() {
          if (connectionId) {
            subManager.removeConnection(connectionId);
          }
        },
      });

      set.headers["content-type"] = "text/event-stream";
      set.headers["cache-control"] = "no-cache";
      set.headers["connection"] = "keep-alive";
      set.headers["x-accel-buffering"] = "no";

      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    });

    // Store manager reference for cleanup on server close
    // biome-ignore lint/suspicious/noExplicitAny: attaching to Elysia instance for lifecycle management
    (app as any).__subscriptionManager = subManager;

    // Register shutdown handler to stop heartbeat/idle timers via Elysia lifecycle only.
    // Avoid process-level signal handlers — they leak when multiple server instances are created.
    app.onStop(() => subManager.stop());
  }

  return app;
}
