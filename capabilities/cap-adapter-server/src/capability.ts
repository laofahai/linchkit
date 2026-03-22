/**
 * Capability definition for cap-adapter-server
 *
 * Registers the HTTP/GraphQL transport and dev server CLI command.
 */

import type { CliCommandContext, TransportContext } from "@linchkit/core";
import { defineCapability } from "@linchkit/core";

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
          const { createRuntimeContext } = await import("./runtime-context");
          const { createServer } = await import("./server");

          // Generate CRUD actions for each schema, skip duplicates
          const allActions = [...ctx.actions];
          for (const schema of ctx.schemas) {
            const cruds = generateCrudActions(schema);
            for (const crud of cruds) {
              if (!allActions.some((a) => a.name === crud.name)) {
                allActions.push(crud);
              }
            }
          }

          // Create a fully-wired runtime — uses provided dataProvider (e.g. Drizzle) or falls back to InMemoryStore
          const runtime = createRuntimeContext({
            schemas: ctx.schemas,
            actions: allActions,
            views: ctx.views,
            states: ctx.states,
            middlewares: ctx.middlewares,
            dataProvider: ctx.dataProvider,
            eventBus: ctx.eventBus,
          });

          const graphqlSchema = buildGraphQLSchema(ctx.schemas, {
            executor: runtime.executor,
            dataProvider: runtime.dataProvider,
          });

          // Read port/host from transport config or runtime config
          const serverCfg = (ctx.config.server ?? {}) as {
            port?: number;
            host?: string;
          };
          const port = serverCfg.port ?? 3001;
          const host = serverCfg.host ?? "0.0.0.0";

          const app = createServer(graphqlSchema, {
            port,
            executor: runtime.executor,
            commandLayer: runtime.commandLayer,
            schemaRegistry: runtime.schemaRegistry,
            views: runtime.views,
            // Extract tenant ID from X-Tenant-ID header.
            // TODO: support JWT-based tenant extraction via auth capability
            resolveRequestTenantId: (request: Request) => {
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
              app.stop();
            },
          };
        },
        config: {
          port: {
            type: "number",
            default: 3001,
            description: "HTTP server port",
          },
          host: {
            type: "string",
            default: "0.0.0.0",
            description: "HTTP server host",
          },
        },
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
