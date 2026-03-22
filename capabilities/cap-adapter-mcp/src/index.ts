/**
 * @linchkit/cap-adapter-mcp — MCP adapter
 *
 * Exposes LinchKit Command Layer as MCP tools and resources.
 */

export { createMcpAdapter } from "./mcp-server";
export type { McpAdapterOptions } from "./mcp-server";
export { fieldToJsonSchema, fieldsToJsonSchema } from "./field-to-json-schema";
export { generateActionTools, generateBuiltinTools } from "./tool-registry";
export type { McpToolDef } from "./tool-registry";
