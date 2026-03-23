/**
 * Define-functions entry point for @linchkit/core/define
 *
 * Exports declarative definition helpers, error classes, Zod schema generator,
 * and all types. Safe for browser — no drizzle-orm or postgres dependencies.
 */

// Define functions
export {
  defineAction,
  defineCapability,
  defineConfig,
  defineDataAccess,
  defineEvent,
  defineEventHandler,
  definePermissionGroup,
  defineRule,
  defineSchema,
  defineState,
  defineView,
  disableRule,
  extendPermissionGroup,
  extendSchema,
  extendState,
  extendView,
  overrideAction,
  overrideRule,
  overrideSchema,
} from "./define";
// Zod schema generator (depends only on zod, browser-safe)
export { generateZodSchema } from "./engine/schema-to-zod";
// Error classes
export {
  AuthenticationError,
  AuthorizationError,
  BusinessRuleError,
  ConflictError,
  LinchKitError,
  NotFoundError,
  SystemError,
  ValidationError,
} from "./errors";
// Re-export all types for convenience
export * from "./types-entry";
