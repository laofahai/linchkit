/**
 * Schema sync utility (dev mode)
 *
 * Generates CREATE TABLE IF NOT EXISTS statements from the TableRegistry
 * and executes them against the database. This is intended for development
 * and prototyping — production deployments should use drizzle-kit migrations.
 */

import { type PgTable, getTableConfig } from "drizzle-orm/pg-core";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import type { TableRegistry } from "./table-registry";

/**
 * Map Drizzle column dataType to SQL type string.
 */
function columnTypeToSQL(col: {
  dataType: string;
  columnType: string;
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle column config varies by type
  config?: any;
}): string {
  switch (col.dataType) {
    case "string": {
      // varchar vs text distinction: check columnType
      if (col.columnType.includes("Varchar")) {
        const length = col.config?.length ?? 255;
        return `varchar(${length})`;
      }
      return "text";
    }
    case "number":
      if (col.columnType.includes("Integer")) return "integer";
      if (col.columnType.includes("DoublePrecision")) return "double precision";
      return "numeric";
    case "boolean":
      return "boolean";
    case "date":
      if (col.columnType.includes("Timestamp")) return "timestamp";
      return "date";
    case "json":
      return "jsonb";
    case "bigint":
      return "bigint";
    default:
      return "text";
  }
}

/**
 * Generate a CREATE TABLE IF NOT EXISTS DDL statement for a Drizzle pgTable.
 */
function generateCreateTableDDL(table: PgTable): string {
  const config = getTableConfig(table);
  const tableName = config.name;
  const columnDefs: string[] = [];

  for (const col of config.columns) {
    const parts: string[] = [`"${col.name}"`, columnTypeToSQL(col as never)];

    if (col.primary) {
      parts.push("PRIMARY KEY");
    }
    if (col.notNull) {
      parts.push("NOT NULL");
    }
    if (col.isUnique) {
      parts.push("UNIQUE");
    }
    if (col.hasDefault && col.default !== undefined) {
      // Use Drizzle's default SQL representation
      const defaultVal = col.defaultFn
        ? null // skip function-based defaults in raw DDL
        : col.default;
      if (defaultVal !== null && defaultVal !== undefined) {
        if (typeof defaultVal === "string") {
          // Escape single quotes for safe SQL interpolation
          const escaped = defaultVal.replace(/'/g, "''");
          parts.push(`DEFAULT '${escaped}'`);
        } else if (typeof defaultVal === "number" || typeof defaultVal === "boolean") {
          parts.push(`DEFAULT ${defaultVal}`);
        }
      } else if (col.defaultFn) {
        // Common convention: now() for timestamps
        // We detect timestamp columns with defaultNow
        if (col.dataType === "date") {
          parts.push("DEFAULT now()");
        }
      }
    }

    columnDefs.push(parts.join(" "));
  }

  return `CREATE TABLE IF NOT EXISTS "${tableName}" (\n  ${columnDefs.join(",\n  ")}\n)`;
}

export interface SyncOptions {
  /** Log generated DDL statements */
  verbose?: boolean;
}

/**
 * Sync all registered tables to the database using CREATE TABLE IF NOT EXISTS.
 *
 * This is a dev-mode utility. For production, use drizzle-kit to generate
 * and apply proper migration files.
 */
export async function syncTables(
  db: PostgresJsDatabase,
  tableRegistry: TableRegistry,
  options?: SyncOptions,
): Promise<void> {
  const schemaNames = tableRegistry.getRegisteredSchemas();

  for (const name of schemaNames) {
    const table = tableRegistry.getTable(name);
    if (!table) continue;

    const ddl = generateCreateTableDDL(table);

    if (options?.verbose) {
      console.log(`[schema-sync] Syncing table for schema "${name}":\n${ddl}\n`);
    }

    await db.execute(sql.raw(ddl));
  }
}
