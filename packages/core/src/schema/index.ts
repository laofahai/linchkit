/**
 * Schema module barrel file
 *
 * Re-exports schema registry, generators, and translatable helpers.
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
} from "./derived-property";
export { generateDrizzleSchemaFile } from "./generate-drizzle-schema";
export { createEntityRegistry, EntityRegistry } from "./entity-registry";
export {
  type DrizzleGeneratorOptions,
  generateDrizzleTable,
  generateLinkColumns,
  type LinkColumnsResult,
} from "./entity-to-drizzle";
export { generateZodSchema, type ZodGeneratorOptions } from "./entity-to-zod";
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
  validateTranslatableSchema,
  wrapTranslatableValue,
} from "./translatable";
