/**
 * Table Registry
 *
 * Maps LinchKit schema names to Drizzle pgTable definitions.
 * Used by DrizzleDataProvider to resolve which table to query
 * for a given schema name.
 */

import type { PgTable } from "drizzle-orm/pg-core";
import type { SchemaDefinition } from "../types/schema";

export class TableRegistry {
  private tables = new Map<string, PgTable>();

  /**
   * Register a Drizzle table definition for a schema name.
   */
  register(schemaName: string, table: PgTable): void {
    this.tables.set(schemaName, table);
  }

  /**
   * Get the Drizzle table for a given schema name.
   */
  getTable(schemaName: string): PgTable | undefined {
    return this.tables.get(schemaName);
  }

  /**
   * Check if a table is registered for a schema name.
   */
  has(schemaName: string): boolean {
    return this.tables.has(schemaName);
  }

  /**
   * Get all registered schema names.
   */
  getRegisteredSchemas(): string[] {
    return Array.from(this.tables.keys());
  }

  /**
   * Build Drizzle table definitions from a schema registry map.
   * Generates pgTable definitions from SchemaDefinition fields
   * using the schema-to-drizzle generator.
   */
  buildFromSchemaRegistry(
    schemas: Map<string, SchemaDefinition>,
  ): void {
    // TODO: iterate schemas, call generateDrizzleTable for each,
    // and register the resulting pgTable definitions.
    // This will be implemented when dynamic table generation is wired up.
    void schemas;
  }
}
