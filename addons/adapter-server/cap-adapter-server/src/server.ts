/**
 * Main HTTP server setup — Elysia + graphql-yoga
 *
 * REST action endpoint returns proper HTTP status codes (see spec 16 §2.5).
 * GraphQL endpoint always returns 200 per GraphQL spec.
 */

import { cors } from "@elysiajs/cors";
import { EnvelopArmorPlugin } from "@escape.tech/graphql-armor";
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
  DeployWebhookHandler,
  HealthCheckRegistry,
  InMemoryMetricsCollector,
  OnchangeEvaluator,
} from "@linchkit/core/server";
import {
  createTenantAwareDataProvider,
  detectEnvironment,
  getCurrentTrace,
} from "@linchkit/core/server";
import { Elysia } from "elysia";
import { type GraphQLSchema, NoSchemaIntrospectionCustomRule } from "graphql";
import { createYoga, type Plugin } from "graphql-yoga";
import { createRelationDataLoaders } from "./graphql/relation-dataloader";
import { mountProposalAPI } from "./proposal-api";
import { mountActionRoutes } from "./routes/action-api";
import { mountAdminRoutes } from "./routes/admin-api";
import { mountAIRoutes } from "./routes/ai-api";
import { mountAIByokRoutes } from "./routes/ai-byok";
import { mountResolveIntentRoute } from "./routes/ai-resolve-intent";
import { mountResolveSchemaIntentRoute } from "./routes/ai-resolve-schema-intent";
import { mountApprovalRoutes } from "./routes/approval-api";
import { mountConfigRoutes } from "./routes/config-api";
import { mountConfigStoreRoutes } from "./routes/config-store-api";
import { mountDeployRoutes } from "./routes/deploy-api";
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
  /**
   * BYOK key store (Spec 36 M2+) — when provided, enables the
   * `/api/ai/byok/keys` endpoints for per-tenant AI key management.
   * The store is opaque to the server: it only persists encrypted
   * key references (KMS lookup tokens), never plaintext keys.
   */
  byokKeyStore?: import("@linchkit/core/ai").BYOKKeyStore;
  /**
   * AI usage meter (Spec 36 M2+) — when provided, enables the
   * `/api/ai/byok/usage` endpoint for per-tenant AI usage aggregation
   * and acts as the recording sink for completed AI calls.
   */
  usageMeter?: import("@linchkit/core/ai").UsageMeter;
  /**
   * GitHub deployment webhook handler (Spec 12 §3).
   * When provided, enables `POST /api/deploy/webhook` to receive GitHub push
   * events and trigger the configured deployment callback.
   */
  deployWebhookHandler?: DeployWebhookHandler;
}

// Re-export parseAcceptLanguage for external consumers
export { parseAcceptLanguage } from "./routes/shared";

/**
 * GraphQL hardening limits (security audit follow-up).
 *
 * The GraphQL schema is auto-generated from the meta-model and exposes
 * bidirectional relation fields, so a query like `a { b { a { b ... } } }`
 * can recurse without bound and trigger compounding N+1 fan-out — a DoS
 * vector. graphql-armor's `maxDepth` + `costLimit` envelop validations cap
 * both the nesting depth and the estimated query cost before resolution.
 *
 * Depth accounting (graphql-armor): each nested selection set adds 1. List
 * queries wrap rows in `xList { items { ... } }`, which already consumes two
 * levels before the first relation hop. The deepest *legitimate* queries the
 * app issues today reach ~5 levels (e.g. `departmentList { items {
 * purchaseRequests { department { name } } } }` — a two-hop bidirectional
 * traversal, or the field-meta introspection-of-lock-metadata queries).
 * `12` leaves comfortable headroom (>2x the deepest legit query) for richer
 * relation chains while still capping unbounded relation cycles to a handful
 * of round-trips.
 */
const GRAPHQL_MAX_DEPTH = 12;

/**
 * Max estimated query cost (graphql-armor `costLimit`). With the plugin
 * defaults (objectCost 2, scalarCost 1, depthCostFactor 1.5) a normal
 * paginated relation query costs well under 1000; armor's own default is
 * 5000. We keep a generous `15000` ceiling so legitimate wide/deep reads pass
 * while a maliciously fanned-out recursive query — whose cost grows
 * factorially with depth — is rejected. Introspection is exempt by default
 * (`ignoreIntrospection: true`), so tooling/tests are unaffected.
 */
const GRAPHQL_MAX_COST = 15_000;

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

  // Resolve the runtime environment via the canonical core helper
  // (BUN_ENV > NODE_ENV; "development"/"test" → non-production). Both
  // development AND test are treated as non-production so local tooling and
  // the test suite keep introspection + the GraphiQL landing page; production
  // and staging lock both down.
  const environment = detectEnvironment();
  const isNonProduction = !environment.isProduction;

  // ── GraphQL hardening (security audit) ───────────────────────
  // graphql-armor wraps the envelop validation phase with query-depth and
  // cost ceilings. Both protections ignore introspection by default, so
  // schema tooling and the test suite (which rely on introspection) are
  // unaffected. blockFieldSuggestion strips "did you mean …" hints from
  // validation errors so a probing actor cannot reconstruct the schema even
  // when introspection is disabled in production.
  const yogaPlugins: Plugin[] = [
    EnvelopArmorPlugin({
      maxDepth: { n: GRAPHQL_MAX_DEPTH },
      costLimit: { maxCost: GRAPHQL_MAX_COST },
      blockFieldSuggestion: { enabled: true },
    }),
  ];

  // Disable schema introspection in production/staging only. In dev/test it
  // stays on (GraphiQL + tests depend on it). Implemented as a thin envelop
  // validation rule using graphql-js's built-in NoSchemaIntrospectionCustomRule,
  // avoiding an extra runtime dependency.
  if (!isNonProduction) {
    yogaPlugins.push({
      onValidate({ addValidationRule }) {
        addValidationRule(NoSchemaIntrospectionCustomRule);
      },
    });
  }

  // Create graphql-yoga instance with actor + tenant context factory
  const yoga = createYoga({
    schema: () => currentSchema,
    graphqlEndpoint: graphqlPath,
    // GraphiQL landing page is a dev/test convenience only; never expose the
    // interactive playground in production/staging.
    landingPage: isNonProduction,
    plugins: yogaPlugins,
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

  // ── Mount route modules ────────────────────────────────────
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
  // Spec 36 M2+ BYOK + usage endpoints (per-tenant key store + meter).
  // Mounted alongside the other AI routes; no-ops when the store /
  // meter are not configured (returns 503 with a structured envelope).
  mountAIByokRoutes(app, opts);
  // Spec 52 §2.6 canonical intent-resolution endpoint. Mounted AFTER
  // mountAIRoutes so the canonical handler (with permission scoping +
  // audit logging) wins routing for `POST /api/ai/resolve-intent` if any
  // legacy handler is left in the file.
  mountResolveIntentRoute(app, opts);
  // Spec 52 "说→有" first slice — NL utterance → governed `add_rule` ProposalDraft.
  mountResolveSchemaIntentRoute(app, opts);
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

  // ── Deployment webhook endpoint (Spec 12 §3) ─────────────────
  mountDeployRoutes(app, opts.deployWebhookHandler);

  // ── Proposal / Evolution / AI Insights endpoints ──────────────
  // Thread the ontology + the env compatibility policy so proposal validation
  // Phase 3 (Spec 09 §4.5) can detect breaking references. strictCompatibility
  // blocks breaking proposals in prod/staging; dev/test stay warn-only.
  mountProposalAPI(app, {
    executionLogger,
    ontology: opts.ontologyRegistry,
    strictCompatibility: environment.features.strictCompatibility,
  });

  // ── SSE Subscription endpoint (/api/subscribe) ────────────────
  mountSubscriptionRoutes(app, opts);

  return app;
}
