/**
 * Schema module barrel file
 *
 * Re-exports schema registry, generators, and translatable helpers.
 */

export {
  type AggregateDerived,
  type ConcatDerived,
  createDerivedPropertyEngine,
  type DerivedConfig,
  type DerivedFieldInfo,
  DerivedPropertyEngine,
  type ExpressionDerived,
  evaluateExpression,
  type FunctionDerived,
  getDerivedStrategy,
  isDerivedField,
  resolveDerivedValue,
} from "./derived-property";
export { generateDrizzleSchemaFile } from "./generate-drizzle-schema";
export { createSchemaRegistry, SchemaRegistry } from "./schema-registry";
export {
  type DrizzleGeneratorOptions,
  generateDrizzleTable,
  generateLinkColumns,
  type LinkColumnsResult,
} from "./schema-to-drizzle";
export { generateZodSchema, type ZodGeneratorOptions } from "./schema-to-zod";
export {
  createTranslatableValue,
  getTranslatableFields,
  mergeTranslatableValue,
  normalizeTranslatableRow,
  normalizeTranslatableValue,
  resolveTranslatableRow,
  resolveTranslatableValue,
  resolveTranslation,
  type TranslatableValue,
  validateTranslatableSchema,
  wrapTranslatableValue,
} from "./translatable";
