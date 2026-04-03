/**
 * Schema-to-Drizzle generator
 *
 * Converts a LinchKit EntityDefinition into a Drizzle pgTable definition
 * for database schema generation and query building.
 */

import {
  boolean,
  date,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import type { RelationDefinition } from "../types/relation";
import type { FieldDefinition, EntityDefinition } from "../types/entity";

export interface DrizzleGeneratorOptions {
  /** Table name prefix (e.g., for multi-tenancy) */
  tablePrefix?: string;
}

// Field types that are virtual and should not produce columns
// Relationship fields (ref/has_many/many_to_many) are handled by generateLinkColumns
const SKIPPED_FIELD_TYPES = new Set(["computed", "ref", "has_many", "many_to_many"]);

/**
 * Type guard for relationship field types that have a `target` property.
 */
function isRelationshipField(
  field: FieldDefinition,
): field is FieldDefinition & { target: string } {
  return field.type === "ref" || field.type === "has_many" || field.type === "many_to_many";
}

/**
 * Convert relationship fields (ref, has_many, many_to_many) from Schema fields
 * to implicit RelationDefinition objects.
 *
 * This implements the "implicit link auto-promotion" feature: existing schema
 * field relationships are automatically promoted to first-class Link objects
 * and merged with explicit defineRelation declarations.
 *
 * If there's a name conflict, explicit links win and a warning is logged.
 *
 * @param schemas - All schema definitions (used to validate targets exist)
 * @param explicitLinks - Explicitly defined links (for conflict detection)
 */
export function convertSchemaRelationshipFieldsToImplicitLinks(
  schemas: EntityDefinition[],
  explicitLinks: RelationDefinition[],
): {
  implicitLinks: RelationDefinition[];
  conflicts: Array<{ name: string; explicit: RelationDefinition; implicit: RelationDefinition }>;
  missingTargets: Array<{ schemaName: string; fieldName: string; target: string }>;
} {
  const implicitLinks: RelationDefinition[] = [];
  const conflicts: Array<{ name: string; explicit: RelationDefinition; implicit: RelationDefinition }> = [];
  const missingTargets: Array<{ schemaName: string; fieldName: string; target: string }> = [];

  // Build a set of existing explicit link names for conflict detection
  const explicitLinkNames = new Set(explicitLinks.map((l) => l.name));
  // Build a set of all schema names for target validation
  const schemaNames = new Set(schemas.map((s) => s.name));

  for (const schema of schemas) {
    const schemaName = schema.name;

    for (const [fieldName, field] of Object.entries(schema.fields)) {
      if (!isRelationshipField(field)) continue;

      const cardinality: RelationDefinition["cardinality"] =
        field.type === "ref"
          ? "many_to_one"
          : field.type === "has_many"
            ? "one_to_many"
            : "many_to_many";
      const target = field.target;

      // Validate target schema exists
      if (!schemaNames.has(target)) {
        missingTargets.push({ schemaName, fieldName, target });
        continue;
      }

      // For implicit links from schema fields:
      // - The original field name becomes the label on the from side (matches what the user wrote)
      // - Reverse direction gets the schema name
      const labelFrom = fieldName;
      const labelTo = schemaName;
      const finalLabelFrom: string | undefined = field.label ?? labelFrom;
      const finalLabelTo: string | undefined = labelTo;

      // Generate a predictable unique name: schemaName_fieldName
      const linkName = `${schemaName}_${fieldName}`;

      // Check for conflict with explicit links
      if (explicitLinkNames.has(linkName)) {
        // biome-ignore lint/style/noNonNullAssertion: name is guaranteed to exist in the set
        const explicit = explicitLinks.find((l) => l.name === linkName)!;
        conflicts.push({
          name: linkName,
          explicit,
          implicit: {
            name: linkName,
            from: schemaName,
            to: target,
            cardinality,
            label: {
              from: finalLabelFrom,
              to: finalLabelTo,
            },
            required: field.required,
          },
        });
        continue;
      }

      // Also check for duplicates among the implicit links we just generated
      // This can happen if same name is generated twice (unlikely but safe-guard)
      if (implicitLinks.some((l) => l.name === linkName)) continue;

      // Create the implicit link
      implicitLinks.push({
        name: linkName,
        from: schemaName,
        to: target,
        cardinality,
        label: {
          from: finalLabelFrom,
          to: finalLabelTo,
        },
        required: field.required,
      });
    }
  }

  return { implicitLinks, conflicts, missingTargets };
}

// Re-use from translatable.ts to avoid duplication
import { TRANSLATABLE_FIELD_TYPES } from "./translatable";

/**
 * Build a Drizzle column definition for a single field.
 *
 * When a field has `translatable: true`, generates a jsonb column instead of the
 * normal column type. The JSONB stores `{ [locale]: value }`.
 */
export function buildColumn(name: string, field: FieldDefinition): unknown {
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
 * Build a fresh set of system columns (id, tenant_id, timestamps, etc.).
 *
 * Each call creates NEW Drizzle column builder instances so they can be
 * passed to `pgTable()` (built columns can't have `.setName()` called again).
 */
// biome-ignore lint/suspicious/noExplicitAny: Drizzle pgTable accepts dynamic column definitions
export function buildSystemColumns(): Record<string, any> {
  return {
    id: varchar("id", { length: 128 }).primaryKey(),
    tenant_id: varchar("tenant_id", { length: 128 }),
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
    created_by: varchar("created_by", { length: 128 }),
    updated_by: varchar("updated_by", { length: 128 }),
    _version: integer("_version").default(1).notNull(),
    deleted_at: timestamp("deleted_at", { mode: "date" }),
  };
}

/**
 * Build the full columns record for a schema (system columns + user-defined fields).
 *
 * Creates fresh Drizzle column builder instances each time, so the result can
 * be merged with additional columns (e.g. FK columns from links) and then
 * passed to `pgTable()`.
 */
// biome-ignore lint/suspicious/noExplicitAny: Drizzle pgTable accepts dynamic column definitions
export function buildTableColumns(schema: EntityDefinition): Record<string, any> {
  const columns = buildSystemColumns();

  for (const [fieldName, field] of Object.entries(schema.fields)) {
    if (SKIPPED_FIELD_TYPES.has(field.type)) {
      continue;
    }
    // Derived fields with "compute" strategy are not stored in DB (spec 48)
    // "store" strategy (default) fields DO get DB columns
    if (field.derived && field.derived.strategy === "compute") {
      continue;
    }
    columns[fieldName] = buildColumn(fieldName, field);
  }

  return columns;
}

/**
 * Generate a Drizzle pgTable definition from a LinchKit EntityDefinition.
 */
export function generateDrizzleTable(
  schema: EntityDefinition,
  options?: DrizzleGeneratorOptions,
): ReturnType<typeof pgTable> {
  const prefix = options?.tablePrefix ? `${options.tablePrefix}_` : "";
  const tableName = `${prefix}${schema.name}`;

  const columns = buildTableColumns(schema);

  return pgTable(tableName, columns);
}

// ── Link-based FK and junction table generation ──────────────────────────

/** Result of generating link columns: FK columns to add to existing tables + junction tables */
export interface LinkColumnsResult {
  /** FK columns keyed by table name → column name → column definition */
  fkColumns: Record<string, Record<string, unknown>>;
  /** Junction tables for many_to_many links */
  junctionTables: ReturnType<typeof pgTable>[];
}

/**
 * Generate FK columns and junction tables from RelationDefinitions.
 *
 * - many_to_one / one_to_one: adds `{to}_id` FK column on the `from` table
 * - one_to_many: adds `{from}_id` FK column on the `to` table
 * - many_to_many: creates a `_link_{name}` junction table with composite PK
 *
 * @param links - All registered link definitions
 * @param tableMap - Map of schema name → generated pgTable (needed for `.references()`)
 * @param options - Generator options (table prefix, etc.)
 */
export function generateLinkColumns(
  links: RelationDefinition[],
  tableMap: Record<string, ReturnType<typeof pgTable>>,
  options?: DrizzleGeneratorOptions,
): LinkColumnsResult {
  const prefix = options?.tablePrefix ? `${options.tablePrefix}_` : "";

  const fkColumns: Record<string, Record<string, unknown>> = {};
  const junctionTables: ReturnType<typeof pgTable>[] = [];

  for (const link of links) {
    switch (link.cardinality) {
      case "many_to_one":
      case "one_to_one": {
        // FK column on the `from` table pointing to `to` table
        const fromTable = `${prefix}${link.from}`;
        const colName = `${link.to}_id`;
        const toTable = tableMap[link.to];
        if (!toTable) break;

        // Build references() with optional onDelete cascade behavior
        const onDeleteAction =
          link.cascade === "delete"
            ? ("cascade" as const)
            : link.cascade === "nullify"
              ? ("set null" as const)
              : undefined;

        let col = onDeleteAction
          ? varchar(colName, { length: 128 }).references(
              // biome-ignore lint/suspicious/noExplicitAny: Drizzle table column access is dynamic
              () => (toTable as any).id,
              { onDelete: onDeleteAction },
            )
          : varchar(colName, { length: 128 }).references(
              // biome-ignore lint/suspicious/noExplicitAny: Drizzle table column access is dynamic
              () => (toTable as any).id,
            );
        if (link.required) {
          col = col.notNull();
        }
        // one_to_one: enforce uniqueness on the FK column
        if (link.cardinality === "one_to_one") {
          col = col.unique();
        }

        if (!fkColumns[fromTable]) fkColumns[fromTable] = {};
        fkColumns[fromTable][colName] = col;
        break;
      }

      case "one_to_many": {
        // FK column on the `to` table pointing to `from` table
        const toTableName = `${prefix}${link.to}`;
        const colName = `${link.from}_id`;
        const fromTable = tableMap[link.from];
        if (!fromTable) break;

        // Build references() with optional onDelete cascade behavior
        const onDeleteAction =
          link.cascade === "delete"
            ? ("cascade" as const)
            : link.cascade === "nullify"
              ? ("set null" as const)
              : undefined;

        let col = onDeleteAction
          ? varchar(colName, { length: 128 }).references(
              // biome-ignore lint/suspicious/noExplicitAny: Drizzle table column access is dynamic
              () => (fromTable as any).id,
              { onDelete: onDeleteAction },
            )
          : varchar(colName, { length: 128 }).references(
              // biome-ignore lint/suspicious/noExplicitAny: Drizzle table column access is dynamic
              () => (fromTable as any).id,
            );
        if (link.required) {
          col = col.notNull();
        }

        if (!fkColumns[toTableName]) fkColumns[toTableName] = {};
        fkColumns[toTableName][colName] = col;
        break;
      }

      case "many_to_many": {
        // Junction table: {prefix}_link_{name} (avoid double underscore when prefix is empty)
        const junctionName = prefix ? `${prefix}_link_${link.name}` : `_link_${link.name}`;
        const fromTable = tableMap[link.from];
        const toTable = tableMap[link.to];
        if (!fromTable || !toTable) break;

        const fromCol = `${link.from}_id`;
        const toCol = `${link.to}_id`;

        // Build onDelete option for junction FK columns
        const onDeleteAction =
          link.cascade === "delete"
            ? ("cascade" as const)
            : link.cascade === "nullify"
              ? ("set null" as const)
              : undefined;

        // biome-ignore lint/suspicious/noExplicitAny: Drizzle pgTable accepts dynamic column definitions
        const cols: Record<string, any> = {
          [fromCol]: onDeleteAction
            ? varchar(fromCol, { length: 128 })
                // biome-ignore lint/suspicious/noExplicitAny: Drizzle table column access is dynamic
                .references(() => (fromTable as any).id, { onDelete: onDeleteAction })
                .notNull()
            : varchar(fromCol, { length: 128 })
                // biome-ignore lint/suspicious/noExplicitAny: Drizzle table column access is dynamic
                .references(() => (fromTable as any).id)
                .notNull(),
          [toCol]: onDeleteAction
            ? varchar(toCol, { length: 128 })
                // biome-ignore lint/suspicious/noExplicitAny: Drizzle table column access is dynamic
                .references(() => (toTable as any).id, { onDelete: onDeleteAction })
                .notNull()
            : varchar(toCol, { length: 128 })
                // biome-ignore lint/suspicious/noExplicitAny: Drizzle table column access is dynamic
                .references(() => (toTable as any).id)
                .notNull(),
        };

        // Extra properties on the junction table
        if (link.properties) {
          for (const [fieldName, field] of Object.entries(link.properties)) {
            cols[fieldName] = buildColumn(fieldName, field);
          }
        }

        const jt = pgTable(
          junctionName,
          cols,
          // biome-ignore lint/suspicious/noExplicitAny: Drizzle extra config callback types are dynamic
          (t: any) => ({
            pk: primaryKey({ columns: [t[fromCol], t[toCol]] }),
          }),
        );

        junctionTables.push(jt);
        break;
      }
    }
  }

  return { fkColumns, junctionTables };
}
