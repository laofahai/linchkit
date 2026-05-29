/**
 * Error classes + helpers (browser-safe).
 */

export type { ToResponseOptions } from "../../errors";
export {
  AuthenticationError,
  AuthorizationError,
  BusinessRuleError,
  ConflictError,
  isAiAgentCaller,
  LinchKitError,
  NotFoundError,
  SystemError,
  shouldIncludeErrorContext,
  ValidationError,
} from "../../errors";
