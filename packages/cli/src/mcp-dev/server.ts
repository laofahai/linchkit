/**
 * MCP Dev Server — Development-time MCP server for LinchKit project introspection.
 *
 * Exposes entity/action/relation/capability discovery, validation tools,
 * and project resources to AI coding tools (Claude Code, Cursor, etc.).
 *
 * This is NOT the runtime MCP adapter (cap-adapter-mcp). This server reads
 * definitions statically from linchkit.config.ts and never touches live data.
 */

import type { CapabilityDefinition } from "@linchkit/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CollectedDefinitions } from "../commands/startup/collect-capabilities";
import { registerDiscoveryTools } from "./discovery-tools";
import { registerGenerationTools } from "./generation-tools";
import { registerPrompts } from "./prompts";
import { registerResources } from "./resources";
import { registerUtilityTools } from "./utility-tools";
import { registerValidationTools } from "./validation-tools";

// ── Types ───────────────────────────────────────────────────────

export interface McpDevServerOptions {
  /** Collected definitions from capabilities */
  definitions: CollectedDefinitions;
  /** Raw capability definitions for capability listing */
  capabilities: CapabilityDefinition[];
  /** Project root directory */
  projectRoot: string;
}

// ── Factory ─────────────────────────────────────────────────────

/**
 * Create a development-time MCP server for project introspection.
 * Registers discovery tools, validation tools, utility tools, resources, and prompts.
 */
export function createMcpDevServer(options: McpDevServerOptions): McpServer {
  const { definitions, capabilities, projectRoot } = options;

  const server = new McpServer(
    {
      name: "linchkit-dev",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
    },
  );

  registerDiscoveryTools(server, definitions, capabilities);
  registerValidationTools(server, definitions);
  registerUtilityTools(server, definitions, capabilities, projectRoot);
  registerGenerationTools(server, definitions, capabilities, projectRoot);
  registerResources(server, definitions);
  registerPrompts(server, definitions, capabilities);

  return server;
}
