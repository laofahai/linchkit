/**
 * MCP SSE Transport — HTTP server for Server-Sent Events transport.
 *
 * Creates a standalone node:http server that serves SSE connections at
 * GET /sse and accepts client messages at POST /messages.
 * Uses the MCP SDK's SSEServerTransport for protocol handling.
 *
 * Bearer token auth is enforced on both endpoints when configured.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Actor } from "@linchkit/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { McpClientRegistry } from "./client-registry";
import type { McpAdapterResult } from "./mcp-server";
import type { ToolPolicy } from "./types";

export interface McpSseServerOptions {
  /**
   * Factory that creates a fresh McpServer + adapter result per SSE session.
   *
   * The MCP SDK only permits one active transport per McpServer instance,
   * so we must create a new server for each concurrent SSE connection.
   * Returns the full adapter result so the SSE layer can set session auth.
   */
  createMcpServer: () => Promise<McpServer | McpAdapterResult>;
  /** Validate bearer token — returns true if auth passes */
  validateAuth: (token: string | undefined) => boolean;
  /** Whether bearer token auth is enabled */
  authEnabled: boolean;
  /** Port to listen on (default: 3002) */
  port?: number;
  /** Client registry for multi-client auth (optional) */
  clientRegistry?: McpClientRegistry;
  /**
   * Resolve an actor from a bearer token.
   * Used when clientRegistry is provided to get per-session actor.
   */
  resolveActor?: (token: string | undefined) => Promise<{
    actor: Actor;
    toolPolicy?: ToolPolicy;
  } | null>;
}

export interface McpSseServerResult {
  /** The underlying HTTP server */
  httpServer: Server;
  /** Start the SSE server */
  start: () => Promise<void>;
  /** Stop the SSE server */
  stop: () => Promise<void>;
}

/**
 * Extract bearer token from Authorization header.
 * Returns undefined if header is missing or malformed.
 */
function extractBearerToken(req: IncomingMessage): string | undefined {
  const authHeader = req.headers.authorization;
  if (!authHeader) return undefined;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

/**
 * Send a JSON error response with the given status code.
 */
function sendError(res: ServerResponse, statusCode: number, message: string): void {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}

/**
 * Create a standalone HTTP server for MCP SSE transport.
 *
 * Routes:
 * - GET /sse — Establish SSE connection (one transport per connection)
 * - POST /messages?sessionId=<id> — Send messages to a specific session
 *
 * Auth: Bearer token is validated on both endpoints when configured.
 */
export function createMcpSseServer(options: McpSseServerOptions): McpSseServerResult {
  const { createMcpServer, validateAuth, authEnabled, port = 3002, resolveActor } = options;

  // Map of active SSE transports keyed by session ID
  const transports = new Map<string, SSEServerTransport>();
  // Map of per-session McpServer instances keyed by session ID
  const sessionServers = new Map<string, McpServer>();

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // CORS headers for cross-origin AI agent access
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");

    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // Auth check on all endpoints
    const token = extractBearerToken(req);
    if (authEnabled) {
      if (!validateAuth(token)) {
        sendError(res, 401, "Unauthorized: invalid or missing bearer token");
        return;
      }
    }

    try {
      // GET /sse — Establish SSE connection
      if (req.method === "GET" && url.pathname === "/sse") {
        const sseTransport = new SSEServerTransport("/messages", res);
        const sessionId = sseTransport.sessionId;

        // Create a fresh McpServer for this session
        const adapterResult = await createMcpServer();
        // Support both McpServer and McpAdapterResult
        const mcpServer: McpServer =
          "server" in adapterResult && "validateAuth" in adapterResult
            ? (adapterResult as McpAdapterResult).server
            : (adapterResult as McpServer);

        // Resolve actor for this session if registry is available
        if (resolveActor && token) {
          const resolved = await resolveActor(token);
          if (resolved && "setSessionAuth" in adapterResult) {
            const setAuth = (
              adapterResult as { setSessionAuth: (a: Actor, p?: ToolPolicy) => void }
            ).setSessionAuth;
            setAuth(resolved.actor, resolved.toolPolicy);
          }
        }

        transports.set(sessionId, sseTransport);
        sessionServers.set(sessionId, mcpServer);

        // Clean up on disconnect
        res.on("close", async () => {
          transports.delete(sessionId);
          const server = sessionServers.get(sessionId);
          sessionServers.delete(sessionId);
          if (server) {
            try {
              await server.close();
            } catch {
              // ignore cleanup errors
            }
          }
        });

        // Connect to MCP server and start SSE stream
        await mcpServer.connect(sseTransport);
        return;
      }

      // POST /messages — Client sends messages to an active session
      if (req.method === "POST" && url.pathname === "/messages") {
        const sessionId = url.searchParams.get("sessionId");
        if (!sessionId) {
          sendError(res, 400, "Missing sessionId query parameter");
          return;
        }

        const sseTransport = transports.get(sessionId);
        if (!sseTransport) {
          sendError(res, 404, "Session not found or expired");
          return;
        }

        await sseTransport.handlePostMessage(req, res);
        return;
      }

      // Unknown route
      sendError(res, 404, "Not found");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[cap-adapter-mcp] SSE handler error: ${message}`);
      if (!res.headersSent) {
        sendError(res, 500, "Internal server error");
      }
    }
  });

  return {
    httpServer,
    start: async () => {
      await new Promise<void>((resolve, reject) => {
        httpServer.on("error", reject);
        httpServer.listen(port, () => {
          httpServer.removeListener("error", reject);
          if (authEnabled) {
            console.log("[cap-adapter-mcp] SSE transport: bearer token auth enabled");
          }
          console.log(`[cap-adapter-mcp] MCP SSE server listening on http://localhost:${port}/sse`);
          resolve();
        });
      });
    },
    stop: async () => {
      // Close all active SSE transports and their per-session McpServer instances
      for (const [, transport] of transports) {
        await transport.close();
      }
      transports.clear();

      for (const [, server] of sessionServers) {
        try {
          await server.close();
        } catch {
          // ignore cleanup errors
        }
      }
      sessionServers.clear();

      // Close the HTTP server
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      console.log("[cap-adapter-mcp] MCP SSE server stopped");
    },
  };
}
