/**
 * Capability definition for cap-adapter-mcp
 *
 * Registers the MCP transport and CLI command for starting the MCP server.
 * Transport factory logic lives in mcp-transport.ts to keep this file declarative.
 * The full parametrized factory (SSE + auth options) lives in factory.ts.
 */

import type { CliCommandContext } from "@linchkit/core";
import { defineCapability } from "@linchkit/core";
import { McpClientRegistry } from "./client-registry";
import { InMemoryMcpClientStore } from "./client-store-memory";
import { capAdapterMcpConfig } from "./config";
import { buildMcpGraphQLExtension } from "./graphql";
import { createMcpTransport } from "./mcp-transport";

// Default registry for the static export (in-memory, dev/test only)
const defaultStore = new InMemoryMcpClientStore();
const defaultRegistry = new McpClientRegistry(defaultStore);

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
        factory: createMcpTransport,
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
    graphqlExtensions: buildMcpGraphQLExtension({ registry: defaultRegistry }),
  },

  systemPermissions: ["network:outbound"],
});
