/**
 * Zod re-export for MCP SDK compatibility.
 *
 * MCP SDK 1.x AnySchema = z3.ZodTypeAny | z4.$ZodType.
 * Only zod/v3 compat layer satisfies z3.ZodTypeAny.
 * zod/v4 classic and default exports don't satisfy either branch (SDK #796).
 * If TS2589 appears on registerPrompt/registerTool calls, see SDK #985.
 */

export { z } from "zod/v3";
