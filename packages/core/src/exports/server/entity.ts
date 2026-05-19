/**
 * Entity-domain runtime — registries + Drizzle generators (server-only).
 */

export {
  createDerivedPropertyEngine,
  DerivedPropertyEngine,
} from "../../entity/derived-property";
export { createInterfaceRegistry, InterfaceRegistry } from "../../entity/entity-interface";
export { createEntityRegistry, EntityRegistry } from "../../entity/entity-registry";
export {
  buildColumn,
  buildSystemColumns,
  buildTableColumns,
  type DrizzleGeneratorOptions,
  generateDrizzleTable,
  generateRelationColumns,
  type RelationColumnsResult,
} from "../../entity/entity-to-drizzle";
export { generateDrizzleSchemaFile } from "../../entity/generate-drizzle-schema";
export { createRelationRegistry, RelationRegistry } from "../../entity/relation-registry";
