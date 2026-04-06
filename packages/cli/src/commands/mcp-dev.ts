/**
 * linch mcp-dev — Start a development-time MCP server for project introspection.
 *
 * Exposes entity/action/relation/capability discovery, validation, and utility
 * tools to AI coding tools (Claude Code, Cursor, etc.) via MCP protocol.
 *
 * Default transport: stdio (for direct integration with AI tools).
 * Optional: SSE on a port (for web-based tools).
 */

import type { LinchKitConfig } from "@linchkit/core";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { defineCommand } from "citty";
import { collectCapabilityDefinitions } from "./startup/collect-capabilities";
import { loadConfig } from "../utils/load-config";
import { createMcpDevServer } from "../mcp-dev/server";

export const mcpDevCommand = defineCommand({
  meta: {
    name: "mcp-dev",
    description: "Start a development-time MCP server for AI coding tools",
  },
  args: {
    transport: {
      type: "string",
      description: "Transport mode: stdio (default) or sse",
      default: "stdio",
    },
    port: {
      type: "string",
      description: "Port for SSE transport (default: 3002)",
      default: "3002",
    },
  },
  async run({ args }) {
    const transport = args.transport as string;
    const port = Number.parseInt(args.port as string, 10);

    // Load project config
    let config: LinchKitConfig;
    let projectRoot: string;
    try {
      const result = await loadConfig();
      config = result.config;
      projectRoot = process.cwd();
    } catch (err) {
      console.error(`Failed to load config: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    // Collect definitions from capabilities
    const capabilities = config.capabilities ?? [];
    const definitions = collectCapabilityDefinitions(capabilities);

    // Create the MCP dev server
    const server = createMcpDevServer({ definitions, capabilities, projectRoot });

    if (transport === "sse") {
      // SSE transport — start HTTP server
      const { SSEServerTransport } = await import("@modelcontextprotocol/sdk/server/sse.js");
      const { createServer } = await import("node:http");

      // Track active transports for cleanup
      const transports = new Map<string, InstanceType<typeof SSEServerTransport>>();

      const httpServer = createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

        if (url.pathname === "/sse" && req.method === "GET") {
          const sseTransport = new SSEServerTransport("/messages", res);
          transports.set(sseTransport.sessionId, sseTransport);
          res.on("close", () => {
            transports.delete(sseTransport.sessionId);
          });
          await server.server.connect(sseTransport);
        } else if (url.pathname === "/messages" && req.method === "POST") {
          const sessionId = url.searchParams.get("sessionId");
          if (!sessionId || !transports.has(sessionId)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid or missing sessionId" }));
            return;
          }
          const sseTransport = transports.get(sessionId);
          if (sseTransport) {
            await sseTransport.handlePostMessage(req, res);
          }
        } else {
          res.writeHead(404);
          res.end("Not found");
        }
      });

      httpServer.listen(port, () => {
        console.error(`[linchkit-dev] MCP SSE server running on http://localhost:${port}/sse`);
      });
    } else {
      // stdio transport (default)
      const stdioTransport = new StdioServerTransport();
      await server.connect(stdioTransport);
      // Server runs until stdin closes
    }
  },
});
