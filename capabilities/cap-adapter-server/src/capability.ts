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
          });

          // Read port/host from config
          const serverCfg = (ctx.config.server ?? {}) as {
            port?: number;
            host?: string;
          };
          const port = serverCfg.port ?? 3001;
          const host = serverCfg.host ?? "0.0.0.0";

          // Use the shared runtime from CLI — no duplicate executor/commandLayer
          const app = createServer(graphqlSchema, {
            port,
            executor: ctx.executor,
            commandLayer: ctx.commandLayer,
            schemaRegistry: ctx.schemaRegistry,
            views: viewsMap,
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
