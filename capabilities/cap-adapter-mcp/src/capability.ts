/**
 * Capability definition for cap-adapter-mcp
 *
 * Registers the MCP transport and CLI command for starting the MCP server.
 * The transport factory wires the MCP server to LinchKit's CommandLayer
 * via stdio transport, exposing all MCP-eligible actions as MCP tools.
 */

import type { CliCommandContext, TransportContext, TransportLifecycle } from "@linchkit/core";
import { defineCapability } from "@linchkit/core";

export const capAdapterMcp = defineCapability({
  name: "cap-adapter-mcp",
  label: "MCP Server",
  type: "adapter",
  category: "integration",
  version: "0.0.1",

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

          // Create MCP server wired to LinchKit registries.
          // Bearer token from transport config — used for GraphQL proxy auth forwarding.
          // stdio transport itself relies on process-level security (no HTTP enforcement).
          const bearerToken = ctx.config?.bearerToken as string | undefined;
          const { server: mcpServer } = await createMcpAdapter({
            commandLayer: ctx.commandLayer,
            schemaRegistry: ctx.schemaRegistry,
            actionRegistry: ctx.executor.registry,
            bearerToken,
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
