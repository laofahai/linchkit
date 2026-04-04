/**
 * Generate .linchkit/drizzle-schema.generated.ts
 *
 * Serializes EntityDefinition[] → pgTable → .ts source file.
 * This is the single bridge between LinchKit's capability-based schema
 * definitions and drizzle-kit's requirement for static .ts schema files.
 *
 * Used by: linch dev, linch db:generate, linch db:push, integration tests.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getTableConfig } from "drizzle-orm/pg-core";
import type { RelationDefinition } from "../types/relation";
import type { FieldDefinition, EntityDefinition } from "../types/entity";
import { generateDrizzleTable, generateRelationColumns } from "./entity-to-drizzle";

const DEFAULT_OUTPUT_DIR = ".linchkit";
const DEFAULT_OUTPUT_FILE = "drizzle-schema.generated.ts";

// SQL type → drizzle-orm/pg-core builder function mapping
const SQL_TYPE_MAP: Record<string, (name: string) => string> = {
  text: (n) => `text("${n}")`,
  boolean: (n) => `boolean("${n}")`,
  integer: (n) => `integer("${n}")`,
  numeric: (n) => `numeric("${n}")`,
  "double precision": (n) => `numeric("${n}")`,
  bigint: (n) => `integer("${n}")`,
  jsonb: (n) => `jsonb("${n}")`,
  date: (n) => `date("${n}")`,
  timestamp: (n) => `timestamp("${n}")`,
  uuid: (n) => `text("${n}")`,
};

export interface GenerateSchemaFileOptions {
  /** Output directory name relative to projectRoot (default: ".linchkit") */
  outputDir?: string;
  /** Output filename (default: "drizzle-schema.generated.ts") */
  outputFile?: string;
}

/**
 * Generate a Drizzle schema barrel file from EntityDefinitions.
 * Returns the absolute path to the generated file.
 */
export function generateDrizzleSchemaFile(
  entities: EntityDefinition[],
  projectRoot: string = process.cwd(),
  options?: GenerateSchemaFileOptions,
  links: RelationDefinition[] = [],
): string {
  const outDir = join(projectRoot, options?.outputDir ?? DEFAULT_OUTPUT_DIR);
  const outPath = join(outDir, options?.outputFile ?? DEFAULT_OUTPUT_FILE);

  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }

  // Build a lookup map for resolving parent entities (spec 49 inheritance)
  const entityMap = new Map<string, EntityDefinition>();
  for (const s of entities) {
    entityMap.set(s.name, s);
  }

  // Phase 1: Generate base tables from schemas
  const tableMap: Record<string, ReturnType<typeof import("drizzle-orm/pg-core").pgTable>> = {};
  const tableExports: string[] = [];

  for (const entity of entities) {
    // Skip abstract entities — they have no DB table (spec 49)
    if (entity.abstract) continue;

    // Flatten inherited fields into concrete child entities (spec 49)
    const flatEntity = flattenInheritedFields(entity, entityMap);

    const table = generateDrizzleTable(flatEntity);
    tableMap[entity.name] = table;
    const config = getTableConfig(table);
    const varName = `${toCamelCase(entity.name)}Table`;

    const columnDefs = config.columns.map((col) => {
      const code = serializeColumn(col as never);
      return `  ${col.name}: ${code}`;
    });

    tableExports.push(
      `export const ${varName} = pgTable("${config.name}", {\n${columnDefs.join(",\n")}\n});`,
    );
  }

  // Phase 2: Generate link FK columns and junction tables
  const linkExports: string[] = [];
  let needsPrimaryKey = false;

  if (links.length > 0) {
    const { fkColumns, junctionTables } = generateRelationColumns(links, tableMap);

    // Append FK columns to existing table exports
    for (const [tableName, cols] of Object.entries(fkColumns)) {
      const colDefs = Object.entries(cols).map(([colName, _col]) => {
        // Find the link that produced this column to get metadata
        const link = links.find((l) => {
          if (
            (l.cardinality === "many_to_one" || l.cardinality === "one_to_one") &&
            tableName.endsWith(l.from)
          ) {
            return `${l.to}_id` === colName;
          }
          if (l.cardinality === "one_to_many" && tableName.endsWith(l.to)) {
            return `${l.from}_id` === colName;
          }
          return false;
        });

        const targetSchema = link?.cardinality === "one_to_many" ? link.from : link?.to;
        const targetVar = targetSchema ? `${toCamelCase(targetSchema)}Table` : "";
        let code = `varchar("${colName}", { length: 128 })`;
        if (targetVar) {
          // Serialize onDelete cascade behavior
          const onDelete =
            link?.cascade === "delete"
              ? "cascade"
              : link?.cascade === "nullify"
                ? "set null"
                : undefined;
          if (onDelete) {
            code += `.references(() => ${targetVar}.id, { onDelete: "${onDelete}" })`;
          } else {
            code += `.references(() => ${targetVar}.id)`;
          }
        }
        if (link?.required) {
          code += ".notNull()";
        }
        // one_to_one: enforce uniqueness on the FK column
        if (link?.cardinality === "one_to_one") {
          code += ".unique()";
        }
        return `  ${colName}: ${code}`;
      });

      // Find and update the matching table export to include FK columns
      const idx = tableExports.findIndex((exp) => exp.includes(`pgTable("${tableName}"`));
      if (idx !== -1) {
        // Insert FK columns before the closing `});`
        const existing = tableExports[idx];
        if (existing) {
          tableExports[idx] = existing.replace(/\n}\);$/, `,\n${colDefs.join(",\n")}\n});`);
        }
      }
    }

    // Generate junction table exports
    for (const jt of junctionTables) {
      needsPrimaryKey = true;
      const config = getTableConfig(jt);
      const varName = `${toCamelCase(config.name)}Table`;

      const columnDefs = config.columns.map((col) => {
        const code = serializeColumn(col as never);
        return `  ${col.name}: ${code}`;
      });

      // Find FK reference targets for .references() serialization
      const refCols: string[] = [];
      for (const col of config.columns) {
        // Check if this column has a FK reference
        const link = links.find(
          (l) => l.cardinality === "many_to_many" && config.name.endsWith(`_link_${l.name}`),
        );
        if (link) {
          // Serialize onDelete cascade behavior for junction FK columns
          const onDelete =
            link.cascade === "delete"
              ? "cascade"
              : link.cascade === "nullify"
                ? "set null"
                : undefined;
          const onDeleteOpt = onDelete ? `, { onDelete: "${onDelete}" }` : "";
          if (col.name === `${link.from}_id`) {
            const ref = `.references(() => ${toCamelCase(link.from)}Table.id${onDeleteOpt})`;
            columnDefs[config.columns.indexOf(col)] =
              `  ${col.name}: ${serializeColumn(col as never)}${ref}`;
            refCols.push(col.name);
          } else if (col.name === `${link.to}_id`) {
            const ref = `.references(() => ${toCamelCase(link.to)}Table.id${onDeleteOpt})`;
            columnDefs[config.columns.indexOf(col)] =
              `  ${col.name}: ${serializeColumn(col as never)}${ref}`;
            refCols.push(col.name);
          }
        }
      }

      // Composite primary key on both FK columns
      const pkCols = refCols.map((c) => `t.${c}`).join(", ");
      const tableBody = pkCols
        ? `{\n${columnDefs.join(",\n")}\n}, (t) => ({\n  pk: primaryKey({ columns: [${pkCols}] }),\n}))`
        : `{\n${columnDefs.join(",\n")}\n})`;

      linkExports.push(`export const ${varName} = pgTable("${config.name}", ${tableBody};`);
    }
  }

  const imports = [
    "boolean",
    "date",
    "integer",
    "jsonb",
    "numeric",
    "pgTable",
    "text",
    "timestamp",
    "varchar",
  ];
  if (needsPrimaryKey) {
    imports.push("primaryKey");
    imports.sort();
  }

  const allExports = [...tableExports, ...linkExports].filter(Boolean);

  const content = `// Auto-generated by linch CLI — do not edit manually
// Regenerated on every \`linch dev\` / \`linch db:generate\`
import { ${imports.join(", ")} } from "drizzle-orm/pg-core";

// System tables (in _linchkit PostgreSQL schema)
export {
  approvalsTable,
  approvalStatusEnum,
  eventsTable,
  eventStatusEnum,
  executionsTable,
  executionStatusEnum,
  linchkitSchema,
} from "@linchkit/core/server";

// Capability tables
${allExports.join("\n\n")}
`;

  writeFileSync(outPath, content, "utf-8");
  return outPath;
}

/**
 * Serialize a Drizzle column object to its TS code representation.
 *
 * Uses getSQLType() to determine the column's SQL type, then maps back to
 * the drizzle-orm builder function. This avoids duplicating the field-type
 * mapping logic from schema-to-drizzle.ts — we read what Drizzle already
 * computed rather than re-computing from EntityDefinition.
 *
 * Known limitations (harmless for current architecture since generated file
 * is only consumed by drizzle-kit for DDL, not for runtime queries):
 * - timestamp({ mode: "date" }) → serialized as timestamp() (mode lost, DDL identical)
 * - defaultRandom() / gen_random_uuid() → not serialized (capability tables use app-generated IDs)
 * - Table-level indexes → not serialized (system table indexes are re-exported directly)
 * - pgEnum types → not serialized (capability tables use varchar for enums)
 */
function serializeColumn(col: {
  name: string;
  dataType: string;
  notNull: boolean;
  hasDefault: boolean;
  default?: unknown;
  defaultFn?: unknown;
  primary: boolean;
  isUnique: boolean;
  getSQLType: () => string;
}): string {
  const sqlType = col.getSQLType();

  // Match against known SQL types; varchar(N) needs special handling
  let code: string;
  const varcharMatch = sqlType.match(/^varchar\((\d+)\)$/);
  if (varcharMatch) {
    code = `varchar("${col.name}", { length: ${varcharMatch[1]} })`;
  } else {
    const builder = SQL_TYPE_MAP[sqlType];
    if (!builder) {
      console.warn(
        `[generate-drizzle-schema] Unknown SQL type "${sqlType}" for column "${col.name}", falling back to text`,
      );
    }
    code = builder ? builder(col.name) : `text("${col.name}")`;
  }

  // Apply modifiers in the same order as schema-to-drizzle.ts
  if (col.primary) code += ".primaryKey()";
  if (col.hasDefault) {
    const def = col.default;
    if (isSqlDefault(def)) {
      // SQL-based defaults: detect now() for .defaultNow()
      const sqlStr = extractSqlString(def);
      if (sqlStr === "now()") {
        code += ".defaultNow()";
      }
      // Other SQL defaults (gen_random_uuid, etc.) — skip, drizzle-kit will introspect
    } else if (col.defaultFn) {
      // Function-based defaults
      if (col.dataType === "date") code += ".defaultNow()";
    } else if (def !== undefined && def !== null) {
      // Scalar defaults
      code += `.default(${JSON.stringify(def)})`;
    }
  }
  if (col.notNull) code += ".notNull()";
  if (col.isUnique) code += ".unique()";

  return code;
}

/** Convert snake_case/kebab-case to camelCase */
function toCamelCase(name: string): string {
  return name
    .split(/[_-]/)
    .map((part, i) => (i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join("");
}

/** Check if a default value is a Drizzle SQL object */
function isSqlDefault(def: unknown): boolean {
  return typeof def === "object" && def !== null && "queryChunks" in def;
}

/**
 * Extract the SQL string from a Drizzle SQL default (e.g. sql`now()` → "now()").
 * NOTE: This reaches into drizzle-orm's internal queryChunks structure, which is
 * not part of the public API and may change between versions. Pinned to drizzle-orm >=0.45.
 */
function extractSqlString(def: unknown): string | null {
  try {
    const chunks = (def as { queryChunks: Array<{ value: string[] }> }).queryChunks;
    if (chunks?.length === 1 && chunks[0]?.value?.length === 1) {
      return chunks[0].value[0] ?? null;
    }
  } catch {
    // Not a recognizable SQL structure
  }
  return null;
}

/**
 * Flatten inherited fields into a concrete schema definition (spec 49).
 *
 * Walks up the inheritance chain and merges parent fields into the child.
 * Child fields override parent fields of the same name.
 * Returns a new EntityDefinition with all inherited fields merged in.
 */
function flattenInheritedFields(
  entity: EntityDefinition,
  entityMap: Map<string, EntityDefinition>,
): EntityDefinition {
  if (!entity.extends) return entity;

  // Collect the inheritance chain from root ancestor to direct parent
  const chain: EntityDefinition[] = [];
  let current: EntityDefinition | undefined = entityMap.get(entity.extends);
  while (current) {
    chain.unshift(current);
    current = current.extends ? entityMap.get(current.extends) : undefined;
  }

  // Merge fields: ancestors first, then child (child overrides)
  const mergedFields: Record<string, FieldDefinition> = {};
  for (const ancestor of chain) {
    for (const [fname, fdef] of Object.entries(ancestor.fields)) {
      mergedFields[fname] = fdef;
    }
  }
  // Child's own fields override inherited ones
  for (const [fname, fdef] of Object.entries(entity.fields)) {
    mergedFields[fname] = fdef;
  }

  return {
    ...entity,
    fields: mergedFields,
  };
}
