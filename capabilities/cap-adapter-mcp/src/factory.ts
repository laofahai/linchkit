/**
 * createCapAdapterMcp — Factory that produces a fully-wired MCP adapter capability.
 *
 * Accepts transport and auth options, returns a CapabilityDefinition with
 * the MCP transport registered in extensions.transports.
 *
 * Usage:
 * ```ts
 * import { createCapAdapterMcp } from '@linchkit/cap-adapter-mcp'
 *
 * const capMcp = createCapAdapterMcp({
 *   transport: 'stdio',
 *   auth: { token: 'my-secret-token' },
 * })
 * ```
 */

import type {
  CapabilityDefinition,
  CliCommandContext,
  TransportAdapterDefinition,
  TransportContext,
} from "@linchkit/core";
import { defineCapability } from "@linchkit/core";
import type { z } from "zod";
import { capAdapterMcpConfig } from "./config";

export interface CapAdapterMcpOptions {
  /** Server name reported in MCP handshake (programmatic dependency) */
  name?: string;
  /** Server version reported in MCP handshake (programmatic dependency) */
  version?: string;

  /** Declarative configuration — validated by capAdapterMcpConfig schema */
  config?: Partial<z.infer<typeof capAdapterMcpConfig.schema>>;
}

/**
 * Create a fully-wired MCP adapter capability.
 *
 * Wires the MCP server to the LinchKit CommandLayer via the transport
 * factory pattern. Defaults to stdio transport when no transport is specified.
 */
export function createCapAdapterMcp(options?: CapAdapterMcpOptions): CapabilityDefinition {
  const serverName = options?.name ?? "linchkit";
  const serverVersion = options?.version ?? "1.0.0";
  const cfg = options?.config;

  const transport: TransportAdapterDefinition = {
    name: "mcp",
    label: "Model Context Protocol",
    factory: async (ctx: TransportContext) => {
      // Lazy import to avoid loading heavy deps at registration time
      const { createMcpAdapter } = await import("./mcp-server");

      // Read config from typed accessor (env resolved, validated, frozen)
      const mcpCfg = capAdapterMcpConfig.from(ctx);
      const { bearerToken, tenantId, graphqlEndpoint } = mcpCfg;
      const transportMode = mcpCfg.transport;
      const ssePort = mcpCfg.ssePort;

      const {
        server: mcpServer,
        validateAuth,
        authEnabled,
      } = await createMcpAdapter({
        commandLayer: ctx.commandLayer,
        schemaRegistry: ctx.schemaRegistry,
        actionRegistry: ctx.executor.registry,
        name: serverName,
        version: serverVersion,
        bearerToken,
        tenantId,
        graphqlEndpoint,
      });

      if (transportMode === "stdio") {
        // stdio transport: process-level security — bearer token is not enforced
        // (the client process is already trusted via OS-level access control).
        const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
        const stdioTransport = new StdioServerTransport();

        return {
          start: async () => {
            if (authEnabled) {
              console.log(
                "[cap-adapter-mcp] Bearer token configured but stdio transport relies on process-level security. " +
                  "Token will be enforced when SSE transport is used.",
              );
            }
            await mcpServer.connect(stdioTransport);
            console.log("[cap-adapter-mcp] MCP server running on stdio");
          },
          stop: async () => {
            await mcpServer.close();
            console.log("[cap-adapter-mcp] MCP server stopped");
          },
        };
      }

      // SSE transport — standalone HTTP server using MCP SDK's SSEServerTransport.
      // Uses node:http for compatibility with the SDK's Node.js-based SSE transport.
      // Each SSE session gets its own McpServer instance because the MCP SDK
      // only permits one active transport per McpServer.
      const { createMcpSseServer } = await import("./sse-transport");

      const adapterOptions = {
        commandLayer: ctx.commandLayer,
        schemaRegistry: ctx.schemaRegistry,
        actionRegistry: ctx.executor.registry,
        name: serverName,
        version: serverVersion,
        bearerToken,
        tenantId,
        graphqlEndpoint,
      };

      const {
        httpServer: _httpServer,
        start,
        stop,
      } = createMcpSseServer({
        createMcpServer: async () => {
          const adapter = await createMcpAdapter(adapterOptions);
          return adapter.server;
        },
        validateAuth,
        authEnabled,
        port: ssePort,
      });

      return { start, stop };
    },
    config: {
      bearerToken: {
        type: "string",
        secret: true,
        description: "Bearer token for MCP auth",
      },
      transport: {
        type: "string",
        default: "stdio",
        description: "Transport mode: stdio or sse",
      },
      ssePort: {
        type: "number",
        default: 3002,
        description: "Port for SSE HTTP server (only used with SSE transport)",
      },
      tenantId: {
        type: "string",
        description: "Tenant ID for multi-tenant scoping",
      },
      graphqlEndpoint: {
        type: "string",
        description: "GraphQL endpoint URL for query proxy (e.g. http://localhost:3001/graphql)",
      },
    },
  };

  return defineCapability({
    name: "cap-adapter-mcp",
    label: "MCP Server",
    description: "Exposes LinchKit actions as MCP tools via stdio or SSE transport",
    type: "adapter",
    category: "integration",
    version: "0.0.1",

    configSchema: capAdapterMcpConfig.schema,
    config: cfg,

    dependencies: [],

    extensions: {
      transports: [transport],
      commands: [
        {
          name: "start",
          namespace: "mcp",
          description: "Start MCP server",
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
            console.log(
              "[cap-adapter-mcp] The MCP transport is started alongside other transports.",
            );
          },
        },
      ],
    },

    systemPermissions: ["network:outbound"],
  });
}
