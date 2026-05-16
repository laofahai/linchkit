/**
 * MCP stdio transport factory for cap-adapter-mcp (default static export).
 *
 * Extracted from capability.ts so the capability definition stays declarative.
 * The full parametrized factory (SSE + stdio, auth options) lives in factory.ts.
 */

import type { TransportContext, TransportLifecycle } from "@linchkit/core";
import { capAdapterMcpConfig } from "./config";

export async function createMcpTransport(ctx: TransportContext): Promise<TransportLifecycle> {
  // Lazy import to avoid loading heavy deps at registration time
  const { createMcpAdapter } = await import("./mcp-server");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");

  // Read config from typed accessor (env resolved, validated, frozen)
  const mcpCfg = capAdapterMcpConfig.from(ctx);
  const { bearerToken, tenantId, graphqlEndpoint } = mcpCfg;
  const { server: mcpServer } = await createMcpAdapter({
    commandLayer: ctx.commandLayer,
    entityRegistry: ctx.entityRegistry,
    actionRegistry: ctx.executor.registry,
    bearerToken,
    tenantId,
    graphqlEndpoint,
  });

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
}
