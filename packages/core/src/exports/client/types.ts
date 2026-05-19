/**
 * Type re-exports from ../../types — meta-model shapes, schemas, version,
 * and lightweight non-type helpers (browser-safe).
 */

export type * from "../../types";
// Non-type exports from types
export {
  capabilityCategoryEnum,
  capabilityMetadataSchema,
  capabilityTypeEnum,
  createExecutionMeta,
  DEFAULT_META_MAX_BYTES,
  ERROR_STATUS_MAP,
  MetaSizeError,
  redactMetaForLog,
  stripSystemKeys,
  validateCapabilityMetadata,
} from "../../types";
export type { ErrorContext } from "../../types/error";
export type { Logger } from "../../types/logger";
export type { PermissionGroupDefinition } from "../../types/permission";
export type {
  RelationGraph,
  SemanticRelation,
  SemanticRelationEndpoint,
  SemanticRelationSource,
  SemanticRelationType,
} from "../../types/semantic-relation";
export { defineSemanticRelation } from "../../types/semantic-relation";
