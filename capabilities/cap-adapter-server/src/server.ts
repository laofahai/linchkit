/**
 * Main HTTP server setup — Elysia + graphql-yoga
 *
 * REST action endpoint returns proper HTTP status codes (see spec 16 §2.5).
 * GraphQL endpoint always returns 200 per GraphQL spec.
 */

import { cors } from "@elysiajs/cors";
import type {
  ActionExecutor,
  Actor,
  AIService,
  AIServiceConfig,
  ApprovalEngine,
  CapabilityDefinition,
  CommandLayer,
  DataProvider,
  EventBus,
  ExecutionLogger,
  FlowDefinition,
  FlowEngine,
  LinchKitConfig,
  OntologyRegistry,
  PermissionGroupDefinition,
  RuleDefinition,
  RuntimeConfigRegistry,
  SchemaDefinition,
  SchemaRegistry,
  StateDefinition,
  SubscriptionConfig,
  ViewDefinition,
} from "@linchkit/core";
import type { HealthCheckRegistry, InMemoryMetricsCollector } from "@linchkit/core/server";
import { createTenantAwareDataProvider } from "@linchkit/core/server";
import { Elysia } from "elysia";
import type { GraphQLSchema } from "graphql";
import { createYoga } from "graphql-yoga";
import { createLinkDataLoaders } from "./graphql/link-dataloader";
import { mountProposalAPI } from "./proposal-api";
import { mountActionRoutes } from "./routes/action-api";
import { mountAdminRoutes } from "./routes/admin-api";
import { mountAIRoutes } from "./routes/ai-api";
import { mountApprovalRoutes } from "./routes/approval-api";
import { mountConfigRoutes } from "./routes/config-api";
import { mountImportRoutes } from "./routes/import-api";
import { mountSchemaRoutes } from "./routes/schema-api";
import { ANONYMOUS_ACTOR, resolveRequestLocale } from "./routes/shared";
import { mountSubscriptionRoutes } from "./routes/subscription-api";

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
  resolveRequestTenantId?: (
    request: Request,
    actor?: Actor,
  ) => Promise<string | undefined> | string | undefined;
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
  /** AI service config — needed for resolving language models in chat endpoint */
  aiConfig?: AIServiceConfig;
  /** Ontology registry for AI context-aware system prompts and tools */
  ontologyRegistry?: OntologyRegistry;
  /** Metrics collector — when provided, /health includes metrics summary */
  metricsCollector?: InMemoryMetricsCollector;
  /** Flow definitions — used by /api/flows endpoints */
  flows?: FlowDefinition[];
  /** Flow engine — used for starting and querying flow instances */
  flowEngine?: FlowEngine;
  /** State definitions — used by /api/states endpoints */
  states?: StateDefinition[];
  /** LinchKit project config — used by /api/settings (sanitized, no secrets) */
  linchKitConfig?: LinchKitConfig;
  /** Approval engine — when provided, enables /api/approvals REST endpoints */
  approvalEngine?: ApprovalEngine;
  /** Runtime config registry — when provided, enables /api/configs REST endpoints */
  runtimeConfigRegistry?: RuntimeConfigRegistry;
}

// Re-export parseAcceptLanguage for external consumers
export { parseAcceptLanguage } from "./routes/shared";

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
  const resolveRequestTenantId = options?.resolveRequestTenantId;
  const resolveRequestActor = options?.resolveRequestActor;
  const dataProvider = options?.dataProvider;
  const corsOption = options?.cors;
  const permissionGroups = options?.permissionGroups ?? [];
  const schemaMap = options?.schemaMap;
  const executionLogger = options?.executionLogger;
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
      const tenantId = resolveRequestTenantId
        ? await resolveRequestTenantId(request, actor)
        : undefined;
      const locale = resolveRequestLocale(request);
      // Wrap DataProvider with tenant isolation for this request so all GraphQL
      // resolvers (get, list, link traversal) enforce row-level tenant scoping.
      const scopedProvider =
        tenantId && dataProvider
          ? createTenantAwareDataProvider(dataProvider, tenantId)
          : dataProvider;
      // Create per-request DataLoaders for batched link resolution (avoids N+1)
      const linkLoaders = scopedProvider ? createLinkDataLoaders(scopedProvider) : undefined;
      return {
        actor,
        tenantId,
        locale,
        dataProvider: scopedProvider,
        permissionGroups,
        schemaMap,
        linkLoaders,
      };
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

  const app = new Elysia().use(
    cors({
      origin: corsOrigin === false ? [] : corsOrigin,
      credentials: false,
    }),
  );

  // Ensure options is defined for route modules (they expect non-optional parameter)
  const opts = options ?? {};

  // ── Mount route modules ──────────────────────────────────
  mountAdminRoutes(app, opts, serverStartedAt);
  mountSchemaRoutes(app, opts);
  mountActionRoutes(app, opts);
  mountImportRoutes(app, opts);
  mountApprovalRoutes(app, opts);
  mountConfigRoutes(app, opts);
  mountAIRoutes(app, opts);

  // Mount graphql-yoga — handle all methods on the graphql path
  app.all(graphqlPath, async ({ request }) => {
    const response = await yoga.handle(request);
    return response;
  });

  // ── Proposal / Evolution / AI Insights endpoints ──────────
  mountProposalAPI(app, executionLogger);

  // ── SSE Subscription endpoint (/api/subscribe) ────────────
  mountSubscriptionRoutes(app, opts);

  return app;
}
