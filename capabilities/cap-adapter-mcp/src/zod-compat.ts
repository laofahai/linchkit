/**
 * Zod v3/v4 compatibility bridge for MCP SDK
 *
 * The MCP SDK (@modelcontextprotocol/sdk) bundles its own zod v3 (3.25.x)
 * while the project uses zod v4. The SDK's zod-compat layer handles both
 * versions at runtime via duck-typing (checking `_zod` property), but
 * TypeScript sees them as incompatible nominal types.
 *
 * This module imports the SDK's own types and provides a typed bridge so
 * we can pass project zod v4 schemas to the MCP SDK without `as any` casts.
 *
 * The SDK's `server.tool()` is generic over the shape parameter, inferring
 * the callback's `args` type from it. We need a mapped type that preserves
 * the shape's keys while converting each value to the SDK's `AnySchema`.
 */

import type {
  AnySchema,
  ZodRawShapeCompat,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";

/**
 * Mapped type that converts each value in a record to the SDK's AnySchema,
 * preserving keys so the SDK's generic overload can infer callback arg types.
 */
type ToMcpShape<T extends Record<string, unknown>> = {
  [K in keyof T]: AnySchema;
};

/**
 * Convert a record of zod v4 schemas into the MCP SDK's ZodRawShapeCompat type.
 *
 * At runtime this is a no-op (identity function). The SDK's zod-compat layer
 * uses duck-typing (`!!schema._zod`) to detect v4 schemas, so project zod v4
 * schemas work correctly. This function exists solely to bridge the TypeScript
 * type gap between two different zod package instances.
 *
 * The generic parameter preserves the shape's keys so that the SDK's
 * `server.tool<Args>()` can still infer callback argument types.
 */
export function toMcpShape<T extends Record<string, unknown>>(
  shape: T,
): ToMcpShape<T> {
  return shape as ToMcpShape<T>;
}

export type { ZodRawShapeCompat, AnySchema };
