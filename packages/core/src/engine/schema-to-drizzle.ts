/**
 * Schema-to-Drizzle generator
 *
 * Converts a LinchKit SchemaDefinition into a Drizzle pgTable definition
 * for database schema generation and query building.
 */

import {
  boolean,
  date,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import type { FieldDefinition, SchemaDefinition } from "../types/schema";

export interface DrizzleGeneratorOptions {
  /** Table name prefix (e.g., for multi-tenancy) */
  tablePrefix?: string;
}

// Field types that are virtual and should not produce columns
const SKIPPED_FIELD_TYPES = new Set(["computed", "has_many", "many_to_many"]);

// Field types that support translatable content (stored as JSONB { locale: value })
const TRANSLATABLE_FIELD_TYPES = new Set(["string", "text", "enum"]);

/**
 * Build a Drizzle column definition for a single field.
 *
 * When a field has `translatable: true`, generates a jsonb column instead of the
 * normal column type. The JSONB stores `{ [locale]: value }`.
 */
function buildColumn(name: string, field: FieldDefinition): unknown {
  let col: ReturnType<
    | typeof varchar
    | typeof text
    | typeof numeric
    | typeof boolean
    | typeof date
    | typeof timestamp
    | typeof jsonb
    | typeof integer
  >;

  // Translatable fields are stored as JSONB regardless of their declared type
  if (field.translatable && TRANSLATABLE_FIELD_TYPES.has(field.type)) {
    col = jsonb(name);

    // Apply constraints (notNull, unique) then return early
    if (field.required) {
      col = col.notNull();
    }
    if (field.unique) {
      col = col.unique();
    }
    return col;
  }

  switch (field.type) {
    case "string":
      col = varchar(name, { length: field.max ?? 255 });
      break;
    case "text":
      col = text(name);
      break;
    case "number":
      col = numeric(name);
      break;
    case "boolean":
      col = boolean(name);
      break;
    case "date":
      col = date(name);
      break;
    case "datetime":
      col = timestamp(name);
      break;
    case "enum":
      col = varchar(name, { length: 50 });
      break;
    case "json":
      col = jsonb(name);
      break;
    case "ref":
      col = varchar(name, { length: 128 });
      break;
    case "state":
      col = varchar(name, { length: 50 });
      break;
    default:
      col = text(name);
      break;
  }

  // Apply constraints
  if (field.required) {
    col = col.notNull();
  }
  if (field.unique) {
    col = col.unique();
  }
  if (field.default !== undefined && field.default !== null) {
    col = col.default(field.default as string & number & boolean);
  }

  return col;
}

/**
 * Generate a Drizzle pgTable definition from a LinchKit SchemaDefinition.
 */
export function generateDrizzleTable(
  schema: SchemaDefinition,
  options?: DrizzleGeneratorOptions,
): ReturnType<typeof pgTable> {
  const prefix = options?.tablePrefix ? `${options.tablePrefix}_` : "";
  const tableName = `${prefix}${schema.name}`;

  // biome-ignore lint/suspicious/noExplicitAny: Drizzle pgTable accepts dynamic column definitions
  const columns: Record<string, any> = {};

  // System columns — always included
  columns.id = varchar("id", { length: 128 }).primaryKey();
  columns.tenant_id = varchar("tenant_id", { length: 128 });
  columns.created_at = timestamp("created_at").defaultNow().notNull();
  columns.updated_at = timestamp("updated_at").defaultNow().notNull();
  columns.created_by = varchar("created_by", { length: 128 });
  columns.updated_by = varchar("updated_by", { length: 128 });
  columns._version = integer("_version").default(1).notNull();
  columns.deleted_at = timestamp("deleted_at", { mode: "date" });

  // User-defined columns
  for (const [fieldName, field] of Object.entries(schema.fields)) {
    if (SKIPPED_FIELD_TYPES.has(field.type)) {
      continue;
    }
    columns[fieldName] = buildColumn(fieldName, field);
  }

  return pgTable(tableName, columns);
}
