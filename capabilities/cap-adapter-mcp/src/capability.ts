/**
 * Capability definition for cap-adapter-mcp
 *
 * Registers the MCP transport and CLI command for starting the MCP server.
 * The transport factory wires the MCP server to LinchKit's CommandLayer
 * via stdio transport, exposing all MCP-eligible actions as MCP tools.
 */

import type { CliCommandContext, TransportContext, TransportLifecycle } from "@linchkit/core";
import { defineCapability } from "@linchkit/core";
import { capAdapterMcpConfig } from "./config";

export const capAdapterMcp = defineCapability({
  name: "cap-adapter-mcp",
  label: "MCP Server",
  type: "adapter",
  category: "integration",
  version: "0.0.1",

  configSchema: capAdapterMcpConfig.schema,

  extensions: {
    transports: [
      {
        name: "mcp",
        label: "Model Context Protocol",
        factory: async (ctx: TransportContext): Promise<TransportLifecycle> => {
          // Lazy import to avoid loading heavy deps at registration time
          const { createMcpAdapter } = await import("./mcp-server");
          const { StdioServerTransport } = await import(
            "@modelcontextprotocol/sdk/server/stdio.js"
          );

          // Read config from typed accessor (env resolved, validated, frozen)
          const mcpCfg = capAdapterMcpConfig.from(ctx);
          const { bearerToken, tenantId, graphqlEndpoint } = mcpCfg;
          const { server: mcpServer } = await createMcpAdapter({
            commandLayer: ctx.commandLayer,
            schemaRegistry: ctx.schemaRegistry,
            actionRegistry: ctx.executor.registry,
            bearerToken,
            tenantId,
            graphqlEndpoint,
          });

          // Create stdio transport instance
          // stdio transport: process-level security — no token enforcement needed
          const stdioTransport = new StdioServerTransport();

          return {
            start: async () => {
              await mcpServer.connect(stdioTransport);
              console.log("[cap-adapter-mcp] MCP server running on stdio");
            },
            stop: async () => {
              await mcpServer.close();
              console.log("[cap-adapter-mcp] MCP server stopped");
            },
          };
        },
        config: {
          bearerToken: {
            type: "string",
            secret: true,
            description: "Bearer token for MCP auth",
          },
          enableStdio: {
            type: "boolean",
            default: true,
            description: "Enable stdio transport",
          },
          tenantId: {
            type: "string",
            description: "Tenant ID for multi-tenant scoping",
          },
          graphqlEndpoint: {
            type: "string",
            description:
              "GraphQL endpoint URL for query proxy (e.g. http://localhost:3001/graphql)",
          },
        },
      },
    ],
    commands: [
      {
        name: "start",
        namespace: "mcp",
        description: "Start MCP server (stdio transport)",
        isDefault: true,
        args: {
          stdio: {
            type: "boolean",
            default: true,
            description: "Enable stdio transport",
          },
        },
        handler: async (_ctx: CliCommandContext) => {
          // The CLI wires transport startup separately via transportCtx.
          // This handler is for standalone `linch mcp start` invocations.
          console.log("[cap-adapter-mcp] Use `linch dev` to start the MCP transport.");
          console.log("[cap-adapter-mcp] The MCP transport is started alongside other transports.");
        },
      },
    ],
  },

  systemPermissions: ["network:outbound"],
});
