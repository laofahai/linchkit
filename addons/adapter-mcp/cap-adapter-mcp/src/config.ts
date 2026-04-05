/**
 * cap-adapter-mcp configuration schema
 *
 * Declares config keys for the MCP transport adapter.
 */

import { defineConfigSchema } from "@linchkit/core/config";
import { z } from "zod";

export const capAdapterMcpConfig = defineConfigSchema("cap-adapter-mcp", {
  bearerToken: z.string().optional().describe("Bearer token for MCP auth"),
  transport: z.enum(["stdio", "sse"]).default("stdio").describe("Transport mode: stdio or sse"),
  ssePort: z.coerce
    .number()
    .default(3002)
    .describe("Port for SSE HTTP server (only used with SSE transport)"),
  tenantId: z.string().optional().describe("Tenant ID for multi-tenant scoping"),
  graphqlEndpoint: z
    .string()
    .optional()
    .describe("GraphQL endpoint URL for query proxy (e.g. http://localhost:3001/graphql)"),
  clientRegistry: z
    .object({
      enabled: z.boolean().optional().describe("Enable MCP client registry for multi-client auth"),
    })
    .optional()
    .describe("Client registry configuration"),
});
