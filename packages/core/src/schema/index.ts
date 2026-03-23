/**
 * Schema module barrel file
 *
 * Re-exports schema registry, generators, and translatable helpers.
 */

export { generateDrizzleSchemaFile } from "./generate-drizzle-schema";
export { createSchemaRegistry, SchemaRegistry } from "./schema-registry";
export {
  type DrizzleGeneratorOptions,
  generateDrizzleTable,
} from "./schema-to-drizzle";
export { generateZodSchema, type ZodGeneratorOptions } from "./schema-to-zod";
export {
  getTranslatableFields,
  mergeTranslatableValue,
  normalizeTranslatableRow,
  normalizeTranslatableValue,
  resolveTranslatableRow,
  resolveTranslatableValue,
  type TranslatableValue,
  wrapTranslatableValue,
} from "./translatable";
