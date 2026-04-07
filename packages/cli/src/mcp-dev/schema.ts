/**
 * Zod re-export for MCP SDK compatibility.
 *
 * MCP SDK's AnySchema = z3.ZodTypeAny | z4.$ZodType.
 * zod/v4 classic wrappers don't satisfy z4.$ZodType (SDK issue #796).
 * zod/v3 compat layer satisfies z3.ZodTypeAny cleanly.
 *
 * When using registerTool/registerPrompt with inputSchema/argsSchema,
 * always annotate callback parameters explicitly to avoid TS2589
 * from zod v3's deeply recursive type inference.
 */

export { z } from "zod/v3";
