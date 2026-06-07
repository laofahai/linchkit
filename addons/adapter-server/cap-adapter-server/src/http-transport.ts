/**
 * HTTP/GraphQL transport factory for cap-adapter-server.
 *
 * Extracted from capability.ts so the capability definition stays declarative.
 * Wires system schemas, data provider, CRUD actions, GraphQL schema, and Elysia
 * server into a TransportLifecycle that capability.ts references by name.
 */

import type { Actor, TransportContext, TransportLifecycle } from "@linchkit/core";
import { serverConfig } from "@linchkit/core";
import { consoleLogger, createOnchangeEvaluator } from "@linchkit/core/server";

export function resolveRequestTenantId(request: Request, actor?: Actor): string | undefined {
  // Prefer tenant from verified actor (auth middleware already validated the JWT).
  // If actor is present but carries no tenant claim, return undefined — do NOT
  // fall back to the header. That would let an authenticated caller control
  // tenant scoping via an unvalidated header value.
  if (actor) {
    const actorTenant =
      actor.tenantId ??
      (typeof actor.metadata?.tenantId === "string" ? actor.metadata.tenantId : undefined) ??
      (typeof actor.metadata?.tenant_id === "string" ? actor.metadata.tenant_id : undefined) ??
      (typeof actor.metadata?.org_id === "string" ? actor.metadata.org_id : undefined);
    return actorTenant;
  }
  // Unauthenticated / dev / service-to-service: accept explicit header.
  const tenantId = request.headers.get("x-tenant-id")?.trim();
  return tenantId ? tenantId : undefined;
}

export async function createHttpTransport(ctx: TransportContext): Promise<TransportLifecycle> {
  // Lazy import to avoid loading heavy deps at capability registration time
  const { buildGraphQLSchema, generateCrudActions } = await import("./graphql/build-schema");
  const { createServer } = await import("./server");
  const { SystemDataProvider } = await import("./system-data-provider");
  const { systemSchemas, systemViews, INTERNAL_SCHEMA_NAMES } = await import("./system-schemas");

  // Register system schemas as internal (read-only, system-managed)
  for (const schema of systemSchemas) {
    if (!ctx.entityRegistry.has(schema.name)) {
      ctx.entityRegistry.registerInternal(schema);
    }
  }

  // Merge system schemas + views into context arrays
  const allSchemas = [...ctx.entities, ...systemSchemas];
  const allViews = [...ctx.views, ...systemViews];

  // Wrap DataProvider to handle internal schema queries
  const systemDataProvider = ctx.dataProvider
    ? new SystemDataProvider(ctx.dataProvider, {
        db: (ctx.dataProvider as { db?: unknown }).db as
          | import("drizzle-orm/postgres-js").PostgresJsDatabase
          | undefined,
        rules: (ctx.capabilities ?? []).flatMap((c) => c.rules ?? []),
        flows: ctx.flowRegistry?.getAll() ?? [],
        states: ctx.states ?? [],
        executionLogger: ctx.executionLogger,
      })
    : undefined;

  // Generate CRUD actions for each business schema (skip internal)
  const crudOpts = ctx.derivedPropertyEngine
    ? { derivedPropertyEngine: ctx.derivedPropertyEngine }
    : undefined;
  for (const schema of ctx.entities) {
    const cruds = generateCrudActions(schema, crudOpts);
    for (const crud of cruds) {
      if (!ctx.executor.registry.has(crud.name)) {
        ctx.executor.registry.register(crud);
      }
    }
  }

  // Build views map from flat array (including system views)
  const viewsMap = new Map<string, import("@linchkit/core/types").ViewDefinition[]>();
  for (const view of allViews) {
    const list = viewsMap.get(view.entity) ?? [];
    list.push(view);
    viewsMap.set(view.entity, list);
  }

  // Collect permission groups for data masking in GraphQL resolvers
  const permGroups = ctx.permissionRegistry?.getAll() ?? [];

  // Construct the onchange evaluator (Spec 64) BEFORE building the GraphQL schema
  // so per-entity `<entity>_onchange` mutations can be auto-generated.
  // No checkReadPermission is wired here — emit a structured warning so operators
  // understand entity-level read gating is not active until cap-permission is installed.
  const onchangeDataProvider = systemDataProvider ?? ctx.dataProvider;
  const onchangeEvaluator = onchangeDataProvider
    ? createOnchangeEvaluator({
        entityRegistry: ctx.entityRegistry,
        dataProvider: onchangeDataProvider,
      })
    : undefined;
  if (onchangeEvaluator) {
    consoleLogger.warn(
      "[onchange] no checkReadPermission configured — lookup/query helpers return data without permission enforcement. Wire cap-permission (or an equivalent) to gate entity reads inside onchange hooks.",
    );
  }

  // Build GraphQL schema — uses composite data provider for all schemas
  const graphqlSchema = buildGraphQLSchema(allSchemas, {
    executor: ctx.executor,
    commandLayer: ctx.commandLayer,
    dataProvider: systemDataProvider ?? ctx.dataProvider,
    relations: ctx.links,
    eventBus: ctx.eventBus,
    permissionGroups: permGroups,
    derivedPropertyEngine: ctx.derivedPropertyEngine,
    stateDefinitions: ctx.states ?? [],
    cacheManager: ctx.cacheManager,
    internalSchemas: INTERNAL_SCHEMA_NAMES,
    onchangeEvaluator,
    overlayRegistry: ctx.overlayRegistry,
  });

  // Read port/host from system:server config (falls back to defaults via Zod)
  const serverCfg = serverConfig.from(ctx);
  const port = serverCfg.port;
  const host = serverCfg.host;

  // Build entity map for relation resolver data masking
  const entityMap = new Map<string, import("@linchkit/core").EntityDefinition>();
  for (const s of ctx.entities) {
    entityMap.set(s.name, s);
  }

  // Collect rule definitions from all capabilities for /api/rules endpoint
  const allRules = (ctx.capabilities ?? []).flatMap((c) => c.rules ?? []);

  const app = createServer(graphqlSchema, {
    port,
    executor: ctx.executor,
    commandLayer: ctx.commandLayer,
    executionLogger: ctx.executionLogger,
    entityRegistry: ctx.entityRegistry,
    views: viewsMap,
    capabilities: ctx.capabilities,
    dataProvider: ctx.dataProvider,
    // Wire the event bus so SSE /api/subscribe is live (subscription-api bails when absent).
    eventBus: ctx.eventBus,
    // Wire the approval engine so /api/approvals works (returns 501 when absent).
    approvalEngine: ctx.approvalEngine,
    // Wire the cache manager so /internal/cache/stats reports real stats (errors when absent).
    cacheManager: ctx.cacheManager,
    healthCheckRegistry: ctx.healthCheckRegistry,
    permissionGroups: permGroups,
    entityMap,
    rules: allRules,
    states: ctx.states,
    flows: ctx.flowRegistry?.getAll() ?? [],
    flowEngine: ctx.flowEngine,
    aiService: ctx.aiService,
    aiConfig: ctx.aiConfig,
    ontologyRegistry: ctx.ontologyRegistry,
    // Spec 52 §1.1 — make the permission registry available to
    // /api/ai/resolve-intent so it can scope the action catalog
    // to actions the calling actor is allowed to execute.
    permissionRegistry: ctx.permissionRegistry,
    // Spec 52 §8.1.4 — every intent_resolution call writes one
    // audit entry through the central AIAuditLogger.
    aiAuditLogger: ctx.aiAuditLogger,
    onchangeEvaluator,
    overlayRegistry: ctx.overlayRegistry,
    resolveRequestTenantId,
    // Spec 55 §7 — enable `POST /api/evolution/run-cycle` so an operator can run
    // one on-demand evolution cycle and land its proposals as governance drafts.
    evolutionRuntime: ctx.evolutionRuntime,
  });

  return {
    start: () => {
      app.listen(port);
      const displayHost = host === "0.0.0.0" ? "localhost" : host;
      console.log(`[cap-adapter-server] HTTP:    http://${displayHost}:${port}`);
      console.log(`[cap-adapter-server] GraphQL: http://${displayHost}:${port}/graphql`);
      console.log(`[cap-adapter-server] Health:  http://${displayHost}:${port}/health`);
    },
    stop: () => {
      // Stop the subscription manager (heartbeat/idle timers) if present
      const subManager = (app as { __subscriptionManager?: { stop?: () => void } })
        .__subscriptionManager;
      if (subManager?.stop) subManager.stop();
      app.stop();
    },
  };
}
