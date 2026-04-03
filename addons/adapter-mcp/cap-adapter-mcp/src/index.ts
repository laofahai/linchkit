/**
 * @linchkit/cap-adapter-mcp — MCP adapter
 *
 * Exposes LinchKit Command Layer as MCP tools and resources.
 */

export { capAdapterMcp } from "./capability";
// Config schema
export { capAdapterMcpConfig } from "./config";
export type { CapAdapterMcpOptions } from "./factory";
export { createCapAdapterMcp } from "./factory";
export { fieldsToJsonSchema, fieldToJsonSchema } from "./field-to-json-schema";
export type { McpAdapterOptions, McpAdapterResult } from "./mcp-server";
export { createMcpAdapter } from "./mcp-server";
export type { McpSseServerOptions, McpSseServerResult } from "./sse-transport";
export { createMcpSseServer } from "./sse-transport";
export type { McpToolDef } from "./tool-registry";
export { generateActionTools, generateBuiltinTools } from "./tool-registry";

// Client Registry
export type {
	McpClient,
	ToolPolicy,
	CreateMcpClientInput,
	UpdateMcpClientInput,
} from "./types";
export type { McpClientStore } from "./client-store";
export { InMemoryMcpClientStore } from "./client-store-memory";
export { DrizzleMcpClientStore } from "./client-store-drizzle";
export { McpClientRegistry } from "./client-registry";
export type { McpClientRegistryOptions, ResolvedMcpClient } from "./client-registry";
export { mcpClientsTable } from "./system-tables";
export { registerManagementTools } from "./management-tools";
export { buildMcpGraphQLExtension } from "./graphql";
export type { McpGraphQLExtension } from "./graphql";
