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
  CapabilityDefinition,
  CommandLayer,
  DataProvider,
  ExecutionLogger,
  ExecutionStatus,
  PermissionGroupDefinition,
  SchemaDefinition,
  SchemaRegistry,
  ViewDefinition,
} from "@linchkit/core";
import { createTenantAwareDataProvider } from "@linchkit/core/server";
import type { HealthCheckRegistry } from "@linchkit/core/server";
import { Elysia } from "elysia";
import type { GraphQLSchema } from "graphql";
import { createYoga } from "graphql-yoga";
import { generateDefaultViews } from "./default-views";
import { createLinkDataLoaders } from "./graphql/link-dataloader";

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
    // App config — tells the UI which capabilities are loaded and their pages
    .get("/api/app-config", () => {
      const authEnabled = capabilities.some((c) => c.name === "cap-auth");
      const pages = capabilities.flatMap((c) => c.pages ?? []);
      return {
        success: true,
        data: {
          authEnabled,
          capabilities: capabilities.map((c) => c.name),
          pages,
        },
      };
    })
    // Tenant list — consumed by TenantSwitcher UI component
    .get("/api/tenants", () => {
      return { success: true, data: tenants };
    })
    // Schema metadata endpoints
    .get("/api/schemas", () => {
      if (!schemaRegistry) {
        return { success: true, data: [] };
      }
      // Lightweight list — only name/label/description for navigation
      const schemas = schemaRegistry.getAll().map((s) => ({
        name: s.name,
        label: s.label,
        description: s.description,
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
    // Mount graphql-yoga — handle all methods on the graphql path
    .all(graphqlPath, async ({ request }) => {
      const response = await yoga.handle(request);
      return response;
    });

  return app;
}
