/**
 * MCP management tools
 *
 * Admin tools for managing MCP client registrations via the MCP protocol itself.
 * Only available to clients whose ToolPolicy allows the "management" category.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { McpClientRegistry } from "./client-registry";
import type { ToolPolicy } from "./types";

/** Tool category tag for management tools */
export const MANAGEMENT_TOOL_CATEGORY = "management";

/** Names of all management tools (used for category filtering) */
export const MANAGEMENT_TOOL_NAMES = [
  "mcp_list_clients",
  "mcp_create_client",
  "mcp_update_client",
  "mcp_toggle_client",
  "mcp_rotate_secret",
  "mcp_usage_stats",
] as const;

/**
 * Register management tools on an MCP server.
 * These tools allow admin clients to manage other MCP clients.
 */
export function registerManagementTools(server: McpServer, registry: McpClientRegistry): void {
  // mcp_list_clients — list registered clients (omit secretHash)
  server.tool(
    "mcp_list_clients",
    "List all registered MCP clients with their configuration (secrets are omitted)",
    // biome-ignore lint/suspicious/noExplicitAny: zod v4 vs SDK bundled zod type mismatch
    { enabled: z.boolean().optional().describe("Filter by enabled status") } as any,
    async (args: { enabled?: boolean }) => {
      const clients = await registry.listClients(
        args.enabled !== undefined ? { enabled: args.enabled } : undefined,
      );

      // Strip secretHash from output
      const safe = clients.map(({ secretHash: _, ...rest }) => rest);

      return {
        content: [{ type: "text" as const, text: JSON.stringify(safe, null, 2) }],
      };
    },
  );

  // mcp_create_client — register a new client, returns credentials
  const createShape = {
    name: z.string().describe("Display name for the client"),
    clientId: z.string().describe("Unique client identifier (used in auth tokens)"),
    description: z.string().optional().describe("Client description"),
    actorType: z.enum(["ai", "service"]).optional().describe("Actor type (default: ai)"),
    actorGroups: z.array(z.string()).optional().describe("Actor group memberships"),
    toolPolicyMode: z
      .enum(["allow_all", "allowlist", "denylist"])
      .optional()
      .describe("Tool policy mode (default: allow_all)"),
    toolPolicyTools: z.array(z.string()).optional().describe("Tool names for allowlist/denylist"),
  };
  server.tool(
    "mcp_create_client",
    "Register a new MCP client. Returns the client record and secret (save it — cannot be retrieved later).",
    // biome-ignore lint/suspicious/noExplicitAny: zod v4 vs SDK bundled zod type mismatch
    createShape as any,
    async (args: {
      name: string;
      clientId: string;
      description?: string;
      actorType?: "ai" | "service";
      actorGroups?: string[];
      toolPolicyMode?: "allow_all" | "allowlist" | "denylist";
      toolPolicyTools?: string[];
    }) => {
      try {
        const { client, secret } = await registry.createClient({
          name: args.name,
          clientId: args.clientId,
          description: args.description,
          actorType: args.actorType,
          actorGroups: args.actorGroups,
          toolPolicy: args.toolPolicyMode
            ? {
                mode: args.toolPolicyMode,
                tools: args.toolPolicyTools ?? [],
              }
            : undefined,
        });

        const { secretHash: _, ...safeClient } = client;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  client: safeClient,
                  secret,
                  tokenFormat: `${client.clientId}:<secret>`,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: `Failed to create client: ${err instanceof Error ? err.message : String(err)}`,
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  // mcp_update_client — update client config
  const updateShape = {
    id: z.string().describe("Client record ID"),
    name: z.string().optional().describe("Updated display name"),
    description: z.string().optional().describe("Updated description"),
    actorType: z.enum(["ai", "service"]).optional().describe("Updated actor type"),
    actorGroups: z.array(z.string()).optional().describe("Updated actor groups"),
    toolPolicyMode: z
      .enum(["allow_all", "allowlist", "denylist"])
      .optional()
      .describe("Updated tool policy mode"),
    toolPolicyTools: z.array(z.string()).optional().describe("Updated tool policy tools"),
  };
  server.tool(
    "mcp_update_client",
    "Update an existing MCP client's configuration",
    // biome-ignore lint/suspicious/noExplicitAny: zod v4 vs SDK bundled zod type mismatch
    updateShape as any,
    async (args: {
      id: string;
      name?: string;
      description?: string;
      actorType?: "ai" | "service";
      actorGroups?: string[];
      toolPolicyMode?: "allow_all" | "allowlist" | "denylist";
      toolPolicyTools?: string[];
    }) => {
      const toolPolicy: ToolPolicy | undefined =
        args.toolPolicyMode !== undefined
          ? {
              mode: args.toolPolicyMode,
              tools: args.toolPolicyTools ?? [],
            }
          : undefined;

      const updated = await registry.updateClient(args.id, {
        name: args.name,
        description: args.description,
        actorType: args.actorType,
        actorGroups: args.actorGroups,
        toolPolicy,
      });

      if (!updated) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: `Client '${args.id}' not found` }),
            },
          ],
          isError: true,
        };
      }

      const { secretHash: _, ...safe } = updated;
      return {
        content: [{ type: "text" as const, text: JSON.stringify(safe, null, 2) }],
      };
    },
  );

  // mcp_toggle_client — enable/disable
  const toggleShape = {
    id: z.string().describe("Client record ID"),
    enabled: z.boolean().describe("Whether to enable or disable the client"),
  };
  server.tool(
    "mcp_toggle_client",
    "Enable or disable an MCP client",
    // biome-ignore lint/suspicious/noExplicitAny: zod v4 vs SDK bundled zod type mismatch
    toggleShape as any,
    async (args: { id: string; enabled: boolean }) => {
      const updated = await registry.toggleClient(args.id, args.enabled);

      if (!updated) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: `Client '${args.id}' not found` }),
            },
          ],
          isError: true,
        };
      }

      const { secretHash: _, ...safe } = updated;
      return {
        content: [{ type: "text" as const, text: JSON.stringify(safe, null, 2) }],
      };
    },
  );

  // mcp_rotate_secret — rotate secret
  const rotateShape = {
    id: z.string().describe("Client record ID"),
  };
  server.tool(
    "mcp_rotate_secret",
    "Rotate the secret for an MCP client. Returns the new secret (save it — cannot be retrieved later).",
    // biome-ignore lint/suspicious/noExplicitAny: zod v4 vs SDK bundled zod type mismatch
    rotateShape as any,
    async (args: { id: string }) => {
      const result = await registry.rotateSecret(args.id);

      if (!result) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: `Client '${args.id}' not found` }),
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                secret: result.secret,
                note: "Save this secret — it cannot be retrieved later.",
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // mcp_usage_stats — stub returning mock data
  server.tool(
    "mcp_usage_stats",
    "Get usage statistics for MCP clients (stub — returns mock data)",
    // biome-ignore lint/suspicious/noExplicitAny: zod v4 vs SDK bundled zod type mismatch
    { clientId: z.string().optional().describe("Filter by client ID") } as any,
    async (args: { clientId?: string }) => {
      // Stub: return mock data
      const stats = {
        period: "last_24h",
        clientId: args.clientId ?? "all",
        totalRequests: 0,
        toolInvocations: {},
        note: "Usage statistics are not yet implemented. This is a stub returning mock data.",
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(stats, null, 2) }],
      };
    },
  );
}
