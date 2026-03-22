/**
 * Capability definition for cap-adapter-mcp
 *
 * Registers the MCP transport and CLI command for starting the MCP server.
 */

import type { CliCommandContext, TransportContext } from "@linchkit/core";
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
        factory: async (_ctx: TransportContext) => {
          // Lazy import — createMcpAdapter needs more than just commandLayer
          const { createMcpAdapter } = await import("./mcp-server");
          void createMcpAdapter;
          return {
            start: () => {
              console.log("[cap-adapter-mcp] MCP transport ready (stdio)");
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
          // Full implementation will be wired in CLI integration
        },
      },
    ],
  },

  systemPermissions: ["network:outbound"],
});
