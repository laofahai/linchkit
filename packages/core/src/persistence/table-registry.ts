/**
 * Table Registry
 *
 * Maps LinchKit schema names to Drizzle pgTable definitions.
 * Used by DrizzleDataProvider to resolve which table to query
 * for a given schema name.
 */

import type { PgTable } from "drizzle-orm/pg-core";
import { type DrizzleGeneratorOptions, generateDrizzleTable } from "../entity/entity-to-drizzle";
import type { EntityDefinition } from "../types/entity";

export class TableRegistry {
  private tables = new Map<string, PgTable>();

  /**
   * Register a Drizzle table definition for a schema name.
   */
  register(entityName: string, table: PgTable): void {
    this.tables.set(entityName, table);
  }

  /**
   * Get the Drizzle table for a given schema name.
   */
  getTable(entityName: string): PgTable | undefined {
    return this.tables.get(entityName);
  }

  /**
   * Check if a table is registered for a schema name.
   */
  has(entityName: string): boolean {
    return this.tables.has(entityName);
  }

  /**
   * Get all registered schema names.
   */
  getRegisteredSchemas(): string[] {
    return Array.from(this.tables.keys());
  }

  /**
   * Build Drizzle table definitions from a schema registry map.
   * Generates pgTable definitions from EntityDefinition fields
   * using the schema-to-drizzle generator.
   */
  buildFromEntityRegistry(
    schemas: Map<string, EntityDefinition>,
    options?: DrizzleGeneratorOptions,
  ): void {
    for (const [name, schema] of schemas) {
      if (this.tables.has(name)) {
        // Skip schemas that already have a manually registered table
        continue;
      }
      const table = generateDrizzleTable(schema, options);
      this.tables.set(name, table);
    }
  }
}
