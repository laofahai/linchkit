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
  CommandLayer,
  ExecutionLogger,
  ExecutionStatus,
  SchemaRegistry,
  ViewDefinition,
} from "@linchkit/core";
import { Elysia } from "elysia";
import type { GraphQLSchema } from "graphql";
import { createYoga } from "graphql-yoga";

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
}

/** Default anonymous actor for unauthenticated REST requests. */
const ANONYMOUS_ACTOR = {
  type: "human" as const,
  id: "anonymous",
  groups: [] as string[],
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
  // State transition conflicts
  if (errorMsg.includes("State transition") || errorMsg.includes("State machine")) return 409;

  // Default: 422 for business logic failures
  return 422;
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

  // Create graphql-yoga instance
  const yoga = createYoga({
    schema: graphqlSchema,
    graphqlEndpoint: graphqlPath,
    // Landing page serves as GraphQL playground in development
    landingPage: true,
  });

  const app = new Elysia()
    .use(
      cors({
        origin: ["http://localhost:3000", "http://localhost:3001"],
        credentials: false,
      }),
    )
    // Health check
    .get("/health", () => ({
      status: "ok",
      timestamp: new Date().toISOString(),
      version: "0.0.1",
    }))
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
      // Bundle schema + views in one response
      const schemaViews = views?.get(params.name) ?? [];
      const viewsMap: Record<string, unknown> = {};
      for (const v of schemaViews) {
        viewsMap[v.name] = v;
      }
      return { success: true, data: { ...schema, views: viewsMap } };
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
          actor: ANONYMOUS_ACTOR,
          channel: "http",
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
        result = await executor.execute(params.name, input, ANONYMOUS_ACTOR, { channel: "http" });
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
    .get("/api/executions", ({ query, set }) => {
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
        const result = executionLogger.findMany({
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
    .get("/api/executions/:id", ({ params, set }) => {
      if (!executionLogger) {
        set.status = 500;
        return { success: false, error: { message: "Execution logger not configured." } };
      }
      const entry = executionLogger.getById(params.id);
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
