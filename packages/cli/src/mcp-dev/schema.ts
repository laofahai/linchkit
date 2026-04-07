/**
 * Zod schema re-export for MCP SDK type compatibility.
 *
 * The MCP SDK's AnySchema type is `z3.ZodTypeAny | z4.$ZodType`.
 * Zod v4 classic wrappers (from `zod/v4`) add properties that create
 * structural type mismatches with `z4.$ZodType` under strict TS checking.
 *
 * We use zod's v3 compat layer since `z3.ZodTypeAny` is the other half
 * of the `AnySchema` union and matches without structural issues.
 */

export { z } from "zod/v3";
