/**
 * Capability definition for cap-adapter-server
 *
 * Registers the HTTP/GraphQL transport and dev server CLI command.
 */

import type { CliCommandContext, TransportContext } from "@linchkit/core";
import { defineCapability, serverConfig } from "@linchkit/core";
import { consoleLogger, createOnchangeEvaluator } from "@linchkit/core/server";

export const capAdapterServer = defineCapability({
  name: "cap-adapter-server",
  label: "HTTP/GraphQL Server",
  type: "adapter",
  category: "integration",
  version: "0.0.1",

  extensions: {
    transports: [
      {
        name: "http",
        label: "HTTP/GraphQL Server",
        factory: async (ctx: TransportContext) => {
          // Lazy import to avoid loading heavy deps at capability registration time
          const { buildGraphQLSchema, generateCrudActions } = await import(
            "./graphql/build-schema"
          );
          const { createServer } = await import("./server");
          const { SystemDataProvider } = await import("./system-data-provider");
          const { systemSchemas, systemViews, INTERNAL_SCHEMA_NAMES } = await import(
            "./system-schemas"
          );

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

          // Construct the onchange evaluator (Spec 64). Use the same data
          // provider chain that the rest of the server uses (system-wrapped
          // when available) so lookups from onchange hooks honor internal
          // schema handling and tenant isolation. No permission callback is
          // wired here either — emit a single structured warning so operators
          // understand entity-level read gating is not active until a
          // permission capability wires a `checkReadPermission`.
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

          // Use the shared runtime from CLI — no duplicate executor/commandLayer
          const app = createServer(graphqlSchema, {
            port,
            executor: ctx.executor,
            commandLayer: ctx.commandLayer,
            executionLogger: ctx.executionLogger,
            entityRegistry: ctx.entityRegistry,
            views: viewsMap,
            capabilities: ctx.capabilities,
            dataProvider: ctx.dataProvider,
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
            onchangeEvaluator,
            // Extract tenant ID from verified actor (set by auth middleware) first,
            // then fall back to X-Tenant-Id header for unauthenticated/dev scenarios.
            // Never decode JWT directly — that bypasses signature verification.
            resolveRequestTenantId: (
              request: Request,
              actor?: { tenantId?: string; metadata?: Record<string, unknown> },
            ) => {
              // Prefer tenant from verified actor (auth middleware already validated the JWT)
              if (actor) {
                const actorTenant =
                  actor.tenantId ??
                  (typeof actor.metadata?.tenantId === "string"
                    ? actor.metadata.tenantId
                    : undefined) ??
                  (typeof actor.metadata?.tenant_id === "string"
                    ? actor.metadata.tenant_id
                    : undefined) ??
                  (typeof actor.metadata?.org_id === "string" ? actor.metadata.org_id : undefined);
                if (actorTenant) {
                  return actorTenant;
                }
              }
              // Fallback: explicit header (e.g., dev mode without auth, or service-to-service)
              return request.headers.get("x-tenant-id") ?? undefined;
            },
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
              // biome-ignore lint/suspicious/noExplicitAny: accessing internal lifecycle ref
              const subManager = (app as any).__subscriptionManager;
              if (subManager?.stop) subManager.stop();
              app.stop();
            },
          };
        },
        // port/host come from system:server config — no transport-level config needed
      },
    ],
    menuItems: [
      {
        id: "relation-graph",
        label: "t:relationGraph.navLabel",
        path: "/admin/graph",
        icon: "Network",
        section: "admin",
        order: 75,
      },
      {
        id: "evolution",
        label: "t:evolution.navLabel",
        path: "/admin/evolution",
        icon: "History",
        section: "admin",
        order: 80,
      },
      {
        id: "system-overview",
        label: "t:systemOverview.title",
        path: "/admin/system",
        icon: "Monitor",
        section: "admin",
        order: 90,
      },
      {
        id: "config-center",
        label: "t:configCenter.title",
        path: "/admin/config",
        icon: "Settings",
        section: "admin",
        order: 95,
      },
    ],
    commands: [
      {
        name: "dev",
        namespace: "server",
        description: "Start HTTP/GraphQL development server",
        isDefault: true,
        devOnly: true,
        args: {
          port: {
            type: "string",
            default: "3001",
            description: "Server port",
          },
          host: {
            type: "string",
            default: "0.0.0.0",
            description: "Server host",
          },
        },
        handler: async (_ctx: CliCommandContext) => {
          console.log("[cap-adapter-server] Starting HTTP/GraphQL dev server...");
          // Full implementation will be wired in CLI integration
        },
      },
    ],
  },

  systemPermissions: ["network:outbound"],
});
