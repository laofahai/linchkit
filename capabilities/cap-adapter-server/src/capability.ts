/**
 * Capability definition for cap-adapter-server
 *
 * Registers the HTTP/GraphQL transport and dev server CLI command.
 */

import type { CliCommandContext, TransportContext } from "@linchkit/core";
import { defineCapability, serverConfig } from "@linchkit/core";

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

          // Generate CRUD actions for each schema, register into executor (skip duplicates)
          for (const schema of ctx.schemas) {
            const cruds = generateCrudActions(schema);
            for (const crud of cruds) {
              if (!ctx.executor.registry.has(crud.name)) {
                ctx.executor.registry.register(crud);
              }
            }
          }

          // Build views map from flat array
          const viewsMap = new Map<string, import("@linchkit/core/types").ViewDefinition[]>();
          for (const view of ctx.views) {
            const list = viewsMap.get(view.schema) ?? [];
            list.push(view);
            viewsMap.set(view.schema, list);
          }

          // Build GraphQL schema using the shared executor + data provider from CLI
          const graphqlSchema = buildGraphQLSchema(ctx.schemas, {
            executor: ctx.executor,
            dataProvider: ctx.dataProvider,
            executionLogger: ctx.executionLogger,
            links: ctx.links,
            eventBus: ctx.eventBus,
          });

          // Read port/host from system:server config (falls back to defaults via Zod)
          const serverCfg = serverConfig.from(ctx);
          const port = serverCfg.port;
          const host = serverCfg.host;

          // Use the shared runtime from CLI — no duplicate executor/commandLayer
          const app = createServer(graphqlSchema, {
            port,
            executor: ctx.executor,
            commandLayer: ctx.commandLayer,
            executionLogger: ctx.executionLogger,
            schemaRegistry: ctx.schemaRegistry,
            views: viewsMap,
            capabilities: ctx.capabilities,
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
        // port/host come from system:server config — no transport-level config needed
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
