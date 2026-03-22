/**
 * Define-functions entry point for @linchkit/core/define
 *
 * Exports declarative definition helpers, error classes, Zod schema generator,
 * and all types. Safe for browser — no drizzle-orm or postgres dependencies.
 */

// Re-export all types for convenience
export * from "./types-entry";

// Define functions
export {
  defineCapability,
  defineSchema,
  defineAction,
  defineRule,
  defineState,
  defineView,
  defineEvent,
  defineEventHandler,
  definePermissionGroup,
  defineDataAccess,
  defineConfig,
  extendSchema,
  extendState,
  extendView,
  extendPermissionGroup,
  overrideSchema,
  overrideAction,
  overrideRule,
  disableRule,
} from "./define";

// Zod schema generator (depends only on zod, browser-safe)
export { generateZodSchema } from "./engine/schema-to-zod";

// Error classes
export {
  LinchKitError,
  ValidationError,
  NotFoundError,
  AuthenticationError,
  AuthorizationError,
  BusinessRuleError,
  ConflictError,
  SystemError,
} from "./errors";
