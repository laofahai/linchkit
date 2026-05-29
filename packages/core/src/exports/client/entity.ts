/**
 * Entity-domain re-exports (browser-safe).
 *
 * Includes derived-property engine, entity / relation registry types,
 * Zod schema generator, translatable value helpers and index helpers.
 */

export {
  type AggregateDerived,
  type CascadeTarget,
  type ConcatDerived,
  computeAggregate,
  createDerivedPropertyEngine,
  type DerivedConfig,
  type DerivedFieldInfo,
  DerivedPropertyEngine,
  type ExpressionDerived,
  evaluateExpression,
  type FunctionDerived,
  getDerivedStrategy,
  isDerivedField,
  resolveAggregateValue,
  resolveDerivedValue,
} from "../../entity/derived-property";
export type { InterfaceRegistry } from "../../entity/entity-interface";
export { createInterfaceRegistry } from "../../entity/entity-interface";
export type { EntityRegistry } from "../../entity/entity-registry";
export { MERGEABLE_CONSTRAINT_KEYS, mergeFieldDefinition } from "../../entity/entity-registry";
export { generateZodSchema, type ZodGeneratorOptions } from "../../entity/entity-to-zod";
export type { RelationRegistry } from "../../entity/relation-registry";
export { createRelationRegistry } from "../../entity/relation-registry";
export {
  createTranslatableValue,
  getTranslatableFields,
  I18N_RAW_KEY,
  mergeTranslatableValue,
  normalizeTranslatableRow,
  normalizeTranslatableValue,
  resolveTranslatableRow,
  resolveTranslatableValue,
  resolveTranslation,
  TRANSLATABLE_FIELD_TYPES,
  type TranslatableValue,
  validateTranslatableEntity,
  wrapTranslatableValue,
} from "../../entity/translatable";
export {
  generateExpressionIndex,
  generateGinIndex,
  generateTranslatableIndexes,
} from "../../entity/translatable-index";
