/**
 * Capability definition for cap-mcp-ui
 *
 * Provides the MCP Client Management UI — admin pages for managing
 * MCP clients, tool policies, and viewing usage statistics.
 */

import { defineCapability } from "@linchkit/core";

export const capMcpUi = defineCapability({
  name: "cap-mcp-ui",
  label: "MCP Management UI",
  type: "standard",
  category: "system",
  version: "0.1.0",
  group: "adapter-mcp",
  dependencies: ["cap-adapter-ui", "cap-adapter-mcp"],
  autoInstall: true,
});
