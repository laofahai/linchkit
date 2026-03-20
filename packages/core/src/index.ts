/**
 * @linchkit/core — Core runtime
 *
 * Meta-model definitions (defineXxx) and type system.
 * Future: Action/Rule/State/Event/Schema engines.
 */

export const VERSION = "0.0.1";

// Type exports
export type * from "./types";

// Define function exports
export {
  defineSchema,
  extendSchema,
  overrideSchema,
  defineAction,
  overrideAction,
  defineRule,
  overrideRule,
  disableRule,
  defineState,
  extendState,
  defineEvent,
  defineEventHandler,
  defineView,
  extendView,
  defineCapability,
} from "./define";

// Non-type exports
export { ERROR_STATUS_MAP } from "./types";
