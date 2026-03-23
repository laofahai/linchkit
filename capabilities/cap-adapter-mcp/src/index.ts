/**
 * @linchkit/cap-adapter-mcp — MCP adapter
 *
 * Exposes LinchKit Command Layer as MCP tools and resources.
 */

export { capAdapterMcp } from "./capability";
export type { CapAdapterMcpOptions } from "./factory";
export { createCapAdapterMcp } from "./factory";
export { fieldsToJsonSchema, fieldToJsonSchema } from "./field-to-json-schema";
export type { McpAdapterOptions } from "./mcp-server";
export { createMcpAdapter } from "./mcp-server";
export type { McpToolDef } from "./tool-registry";
export { generateActionTools, generateBuiltinTools } from "./tool-registry";
