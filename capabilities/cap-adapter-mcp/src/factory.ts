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

export interface CapAdapterMcpOptions {
  /** Transport mode: stdio (default) or sse */
  transport?: "stdio" | "sse";
  /** Authentication options */
  auth?: {
    /** Bearer token for simple Phase 1 auth */
    token?: string;
  };
  /** Server name reported in MCP handshake */
  name?: string;
  /** Server version reported in MCP handshake */
  version?: string;
}

/**
 * Create a fully-wired MCP adapter capability.
 *
 * Wires the MCP server to the LinchKit CommandLayer via the transport
 * factory pattern. Defaults to stdio transport when no transport is specified.
 */
export function createCapAdapterMcp(options?: CapAdapterMcpOptions): CapabilityDefinition {
  const transportMode = options?.transport ?? "stdio";
  const bearerToken = options?.auth?.token;
  const serverName = options?.name ?? "linchkit";
  const serverVersion = options?.version ?? "1.0.0";

  const transport: TransportAdapterDefinition = {
    name: "mcp",
    label: "Model Context Protocol",
    factory: async (ctx: TransportContext) => {
      // Lazy import to avoid loading heavy deps at registration time
      const { createMcpAdapter } = await import("./mcp-server");

      const mcpServer = await createMcpAdapter({
        commandLayer: ctx.commandLayer,
        schemaRegistry: ctx.schemaRegistry,
        actionRegistry: ctx.executor.registry,
        name: serverName,
        version: serverVersion,
        bearerToken,
      });

      if (transportMode === "stdio") {
        const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
        const stdioTransport = new StdioServerTransport();

        return {
          start: async () => {
            await mcpServer.connect(stdioTransport);
            console.log("[cap-adapter-mcp] MCP server running on stdio");
          },
          stop: async () => {
            await mcpServer.close();
          },
        };
      }

      // SSE transport — placeholder for future implementation
      return {
        start: () => {
          console.log("[cap-adapter-mcp] MCP SSE transport not yet implemented");
        },
        stop: () => {
          /* cleanup */
        },
      };
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
    },
  };

  return defineCapability({
    name: "cap-adapter-mcp",
    label: "MCP Server",
    description: "Exposes LinchKit actions as MCP tools via stdio or SSE transport",
    type: "adapter",
    category: "integration",
    version: "0.0.1",

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
            console.log("[cap-adapter-mcp] Starting MCP server...");
            // Full implementation wired via transport factory
          },
        },
      ],
    },

    systemPermissions: ["network:outbound"],
  });
}
