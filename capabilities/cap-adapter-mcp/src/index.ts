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
