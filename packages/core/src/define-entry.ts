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
  defineEntity,
  defineState,
  defineView,
  disableRule,
  extendPermissionGroup,
  extendEntity,
  extendState,
  extendView,
  overrideAction,
  overrideRule,
  overrideEntity,
} from "./define";
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
// Zod schema generator (depends only on zod, browser-safe)
export { generateZodSchema } from "./entity/entity-to-zod";
// Re-export all types for convenience
export * from "./types-entry";
