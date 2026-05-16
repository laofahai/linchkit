/**
 * Core type exports
 */

export type * from "./action";
export type * from "./ai";
export type * from "./approval";
export type * from "./batch";
export type * from "./capability";
export type {
  CapabilityMetadata,
  CapabilityMetadataValidationError,
  CapabilityMetadataValidationResult,
} from "./capability-metadata";
export {
  capabilityCategoryEnum,
  capabilityMetadataSchema,
  capabilityTypeEnum,
  validateCapabilityMetadata,
} from "./capability-metadata";
export type * from "./cli";
export type * from "./command";
export type * from "./config";
export type * from "./database";
export type * from "./entity";
export type * from "./error";
// Non-type exports
export { ERROR_STATUS_MAP } from "./error";
export type * from "./event";
export type * from "./execution-log";
export type {
  CreateExecutionMetaOptions,
  ExecutionMeta,
} from "./execution-meta";
// Non-type exports: MetaSizeError class, factory, constant.
// `ExecutionMetaImpl` and `extendExecutionMeta` are deliberately NOT exported —
// they are framework-internal. Making them public would let callers bypass
// the `createExecutionMeta` factory's `_`-prefix stripping and spoof system
// keys (Gemini review feedback on PR #201). Engine code imports directly from
// the module. Downstream callers construct meta only via `createExecutionMeta`.
export {
  createExecutionMeta,
  DEFAULT_META_MAX_BYTES,
  MetaSizeError,
  redactMetaForLog,
  stripSystemKeys,
} from "./execution-meta";
export type * from "./flow";
export type * from "./life-system";
export type * from "./logger";
export type * from "./meta-semantics";
export type * from "./onchange";
export type * from "./overlay";
export type * from "./page";
export type * from "./permission";
export type * from "./proposal";
export type * from "./relation";
export type * from "./rule";
export type * from "./runtime-config";
export type * from "./semantic-relation";
export { defineSemanticRelation } from "./semantic-relation";
export type * from "./state";
export type * from "./template";
export type * from "./transport";
export type * from "./version";
export type * from "./view";
export type * from "./watcher";
export type * from "./widget";
