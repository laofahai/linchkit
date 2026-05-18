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
  ConfigStore,
  DataProvider,
  EntityDefinition,
  EntityRegistry,
  EventBus,
  ExecutionLogger,
  FlowDefinition,
  FlowEngine,
  LinchKitConfig,
  OntologyRegistry,
  PermissionGroupDefinition,
  PermissionRegistry,
  RuleDefinition,
  RuntimeConfigRegistry,
  StateDefinition,
  SubscriptionConfig,
  TransactionManager,
  ViewDefinition,
} from "@linchkit/core";
import type {
  AIAuditLogger,
  CacheManager,
  HealthCheckRegistry,
  InMemoryMetricsCollector,
  OnchangeEvaluator,
} from "@linchkit/core/server";
import { createTenantAwareDataProvider, getCurrentTrace } from "@linchkit/core/server";
import { Elysia } from "elysia";
import type { GraphQLSchema } from "graphql";
import { createYoga } from "graphql-yoga";
import { createRelationDataLoaders } from "./graphql/relation-dataloader";
import { mountProposalAPI } from "./proposal-api";
import { mountActionRoutes } from "./routes/action-api";
import { mountAdminRoutes } from "./routes/admin-api";
import { mountAIRoutes } from "./routes/ai-api";
import { mountResolveIntentRoute } from "./routes/ai-resolve-intent";
import { mountApprovalRoutes } from "./routes/approval-api";
import { mountConfigRoutes } from "./routes/config-api";
import { mountConfigStoreRoutes } from "./routes/config-store-api";
import { mountEntityRoutes } from "./routes/entity-api";
import { mountHealthRoutes } from "./routes/health";
import { mountImportRoutes } from "./routes/import-api";
import { mountOnchangeRoutes } from "./routes/onchange-api";
import { mountOverlayRoutes } from "./routes/overlay-api";
import { ANONYMOUS_ACTOR, NO_AUTH_ACTOR, resolveRequestLocale } from "./routes/shared";
import { mountSubscriptionRoutes } from "./routes/subscription-api";
import { mountTranslationRoutes } from "./routes/translation-api";

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
  /**
   * Transaction manager — required by `POST /api/actions/batch` for the
   * `all_or_nothing` strategy. Without it, batch requests using
   * `all_or_nothing` are rejected with a structured failure.
   */
  transactionManager?: TransactionManager;
  /** Execution logger for log query endpoints */
  executionLogger?: ExecutionLogger;
  /** Schema registry for metadata endpoints */
  entityRegistry?: EntityRegistry;
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
  /** Entity definitions map for data masking in link resolvers */
  entityMap?: Map<string, EntityDefinition>;
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
  /**
   * Permission registry — when provided, the intent resolver scopes its
   * action catalog to actions the calling actor can execute (Spec 52 §1.1).
   */
  permissionRegistry?: PermissionRegistry;
  /**
   * AI audit logger — when provided, AI-touching endpoints (e.g.
   * `/api/ai/resolve-intent`) emit one entry per call (Spec 52 §8.1.4).
   */
  aiAuditLogger?: AIAuditLogger;
  /**
   * Intent resolver tunables — Spec 52 Phase 1 hardening (#262 item 1).
   * When the actor-visible catalog is large, the intent resolver lexically
   * pre-filters it to keep only the entries plausibly relevant to the
   * user's prompt. Defaults are chosen to fit a comfortable AI context
   * window for typical ontologies; override per-deployment if needed.
   */
  intentResolverOptions?: {
    /** Max distinct entities surfaced to the AI. Default 20. */
    maxEntities?: number;
    /** Max actions per kept entity. Default 20. */
    maxActionsPerEntity?: number;
  };
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
  /** ConfigStore — dynamic KV config with scope cascade and versioning (spec 42) */
  configStore?: ConfigStore;
  /** Cache manager — when provided, enables /internal/cache/stats endpoint */
  cacheManager?: CacheManager;
  /** Overlay registry — when provided, enables /api/overlays REST endpoints */
  overlayRegistry?: import("@linchkit/core/server").OverlayRegistry;
  /**
   * Onchange evaluator (Spec 64) — when provided, enables
   * `POST /api/entities/:name/onchange` for interactive form computation.
   */
  onchangeEvaluator?: OnchangeEvaluator;
  /**
   * Callback to rebuild GraphQL schema after overlay changes.
   * Receives the current yoga instance and triggers schema replacement.
   */
  rebuildGraphQLSchema?: () => GraphQLSchema;
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
  const entityMap = options?.entityMap;
  const executionLogger = options?.executionLogger;
  const serverStartedAt = Date.now();

  // Track current schema for hot-reload support
  let currentSchema = graphqlSchema;

  // Create graphql-yoga instance with actor + tenant context factory
  const yoga = createYoga({
    schema: () => currentSchema,
    graphqlEndpoint: graphqlPath,
    // Landing page serves as GraphQL playground in development
    landingPage: true,
    // Build GraphQL context with actor, tenant isolation, locale, data provider, and masking context for link resolvers
    context: async ({ request }) => {
      const actor = resolveRequestActor
        ? ((await resolveRequestActor(request)) ?? ANONYMOUS_ACTOR)
        : NO_AUTH_ACTOR;
      const tenantId = resolveRequestTenantId
        ? await resolveRequestTenantId(request, actor)
        : undefined;
      const locale = resolveRequestLocale(request);
      // Forwarding policy (issue #236): collect every inbound HTTP header into
      // a lowercase-keyed plain object so CommandLayer middleware sees the same
      // surface for GraphQL as for REST (`routes/action-api.ts`). REST forwards
      // every header verbatim — this keeps GraphQL on the same contract.
      const headers: Record<string, string> = {};
      for (const [key, value] of request.headers.entries()) {
        headers[key] = value;
      }
      // Wrap DataProvider with tenant isolation for this request so all GraphQL
      // resolvers (get, list, link traversal) enforce row-level tenant scoping.
      const scopedProvider =
        tenantId && dataProvider
          ? createTenantAwareDataProvider(dataProvider, tenantId)
          : dataProvider;
      // Create per-request DataLoaders for batched link resolution (avoids N+1)
      const relationLoaders = scopedProvider
        ? createRelationDataLoaders(scopedProvider)
        : undefined;
      return {
        actor,
        tenantId,
        locale,
        headers,
        dataProvider: scopedProvider,
        permissionGroups,
        entityMap,
        relationLoaders,
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

  // Propagate trace ID to all HTTP responses via X-Trace-Id header
  app.onAfterHandle(({ set }) => {
    // Use the trace ID from AsyncLocalStorage (set by CommandLayer) when available,
    // otherwise generate a fresh one so all responses include X-Trace-Id.
    const activeTrace = getCurrentTrace();
    set.headers["x-trace-id"] = activeTrace?.traceId ?? crypto.randomUUID();
  });

  // Ensure options is defined for route modules (they expect non-optional parameter)
  const opts = options ?? {};

  // ── Mount route modules ──────────────────────────────────
  mountAdminRoutes(app, opts, serverStartedAt);
  // Mounted AFTER admin so the canonical, minimal `/health` (Spec 12 — liveness)
  // overrides any duplicate handler in admin-api.ts. `/ready` is exclusive to
  // this module.
  mountHealthRoutes(app, opts);
  mountEntityRoutes(app, opts);
  mountActionRoutes(app, opts);
  mountImportRoutes(app, opts);
  mountApprovalRoutes(app, opts);
  mountConfigRoutes(app, opts);
  mountConfigStoreRoutes(app, opts);
  mountAIRoutes(app, opts);
  // Spec 52 §2.6 canonical intent-resolution endpoint. Mounted AFTER
  // mountAIRoutes so the canonical handler (with permission scoping +
  // audit logging) wins routing for `POST /api/ai/resolve-intent` if any
  // legacy handler is left in the file.
  mountResolveIntentRoute(app, opts);
  mountTranslationRoutes(app, opts);
  mountOnchangeRoutes(app, opts, opts.onchangeEvaluator);

  // Mount overlay management endpoints when overlay registry is available
  if (options?.overlayRegistry) {
    const overlayRegistry = options.overlayRegistry;
    const rebuildSchema = options?.rebuildGraphQLSchema;
    const entityNameSet = options?.entityMap ? new Set(options.entityMap.keys()) : undefined;
    mountOverlayRoutes(app, {
      overlayRegistry,
      entityNames: entityNameSet,
      onOverlayChange: rebuildSchema
        ? (_entityName: string) => {
            // Hot-reload GraphQL schema after overlay CRUD
            currentSchema = rebuildSchema();
          }
        : undefined,
    });
  }

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
