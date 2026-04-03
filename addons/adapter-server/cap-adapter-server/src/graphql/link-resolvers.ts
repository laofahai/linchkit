/**
 * Link-based relation field generation for GraphQL.
 *
 * Generates resolver fields that navigate Link relationships (many_to_one,
 * one_to_many, one_to_one, many_to_many) with data masking support.
 *
 * Uses DataLoader for batched loading to avoid N+1 query problems.
 *
 * Extracted from schema-to-graphql.ts to keep each module focused.
 */

import type {
  Actor,
  DataProvider,
  FieldDefinition,
  RelationDefinition,
  Logger,
  MaskRecordOptions,
  PermissionGroupDefinition,
  EntityDefinition,
} from "@linchkit/core";
import { maskRecord } from "@linchkit/core/server";
import {
  GraphQLBoolean,
  GraphQLFloat,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  type GraphQLOutputType,
  GraphQLString,
} from "graphql";
import type { LinkDataLoaders } from "./link-dataloader";

// ── Types ──────────────────────────────────────────────────

/** Context for resolving link relation fields */
export interface LinkResolverContext {
  /** Data provider for fetching related records (optional — resolvers degrade gracefully) */
  dataProvider?: DataProvider;
  /** Tenant ID for data isolation */
  tenantId?: string;
  /** Authenticated actor for permission-based data masking */
  actor?: Actor;
  /** Permission groups for data masking unmask checks */
  permissionGroups?: PermissionGroupDefinition[];
  /** Schema definitions map for data masking lookups */
  schemaMap?: Map<string, EntityDefinition>;
  /** Per-request DataLoaders for batched link resolution (created in context factory) */
  linkLoaders?: LinkDataLoaders;
}

// ── Masking helpers ────────────────────────────────────────

/** Field types whose masked values cannot be represented as strings in GraphQL (must become null) */
const NON_STRING_FIELD_TYPES = new Set(["number", "boolean", "date", "datetime", "json"]);

/**
 * Apply data masking to a single record using context actor and permissions.
 * Returns the masked record with non-string masked fields coerced to null.
 */
function applyLinkMasking(
  record: Record<string, unknown>,
  schemaName: string,
  ctx: LinkResolverContext,
): Record<string, unknown> {
  if (!ctx.actor || !ctx.schemaMap) return record;
  const schemaDef = ctx.schemaMap.get(schemaName);
  if (!schemaDef) return record;
  const maskOpts: MaskRecordOptions = {
    actor: ctx.actor,
    groups: ctx.permissionGroups ?? [],
    capabilityName: schemaDef.name,
  };
  const masked = maskRecord(record, schemaDef, maskOpts);
  // Coerce masked non-string fields to null (GraphQL type mismatch)
  for (const [fieldName, fieldDef] of Object.entries(schemaDef.fields)) {
    if (
      NON_STRING_FIELD_TYPES.has(fieldDef.type) &&
      typeof masked[fieldName] === "string" &&
      masked[fieldName] !== record[fieldName]
    ) {
      masked[fieldName] = null;
    }
  }
  return masked;
}

/**
 * Apply data masking to an array of records.
 */
function applyLinkMaskingArray(
  records: Record<string, unknown>[],
  schemaName: string,
  ctx: LinkResolverContext,
): Record<string, unknown>[] {
  return records.map((r) => applyLinkMasking(r, schemaName, ctx));
}

// ── DataLoader-aware fetch helpers ─────────────────────────

/**
 * Fetch a single record by ID, using DataLoader when available.
 */
async function fetchOne(
  schema: string,
  id: string,
  ctx: LinkResolverContext,
): Promise<Record<string, unknown> | null> {
  if (ctx.linkLoaders) {
    return ctx.linkLoaders.getLoader.load({ schema, id, tenantId: ctx.tenantId });
  }
  // Fallback: direct dataProvider call (backward compatible)
  if (!ctx.dataProvider) return null;
  const record = await ctx.dataProvider.get(schema, id, { tenantId: ctx.tenantId });
  return (record as Record<string, unknown>) ?? null;
}

/**
 * Query records by FK filter, using DataLoader when available.
 */
async function fetchByFK(
  schema: string,
  fkColumn: string,
  fkValue: string,
  ctx: LinkResolverContext,
): Promise<Record<string, unknown>[]> {
  if (ctx.linkLoaders) {
    return ctx.linkLoaders.queryLoader.load({ schema, fkColumn, fkValue, tenantId: ctx.tenantId });
  }
  // Fallback: direct dataProvider call (backward compatible)
  if (!ctx.dataProvider) return [];
  return (await ctx.dataProvider.query(
    schema,
    { [fkColumn]: fkValue },
    { tenantId: ctx.tenantId },
  )) as Record<string, unknown>[];
}

// ── Edge type helpers for M:N with properties ──────────────

const GRAPHQL_NAME_RE = /^[_A-Za-z][_0-9A-Za-z]*$/;

/** Convert a snake_case name to PascalCase for GraphQL type names */
function toPascalCase(name: string): string {
  const raw = name
    .split(/[_-]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  const sanitized = raw.replace(/[^_0-9A-Za-z]/g, "");
  return GRAPHQL_NAME_RE.test(sanitized) ? sanitized : `_${sanitized}`;
}

/** Convert a snake_case name to camelCase for GraphQL field names */
function toCamelCase(name: string): string {
  const pascal = toPascalCase(name);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

/** Map a FieldDefinition type to a GraphQL output type for edge properties */
function mapPropertyToGraphQLType(field: FieldDefinition): GraphQLOutputType {
  switch (field.type) {
    case "number":
      return GraphQLFloat;
    case "boolean":
      return GraphQLBoolean;
    case "string":
    case "text":
    case "date":
    case "datetime":
    case "json":
      return GraphQLString;
    default:
      return GraphQLString;
  }
}

/** Cache for edge types to avoid duplicate type names */
const edgeTypeCache = new Map<string, GraphQLObjectType>();

/**
 * Build a GraphQL edge type for an M:N link with properties.
 * The edge type contains the related record plus all junction table property fields.
 *
 * Direction-specific naming:
 * - From side: SalesOrderProductEdge { product: Product!, quantity: Float!, ... }
 * - To side:   ProductSalesOrderEdge { salesOrder: SalesOrder!, quantity: Float!, ... }
 */
function getOrCreateEdgeType(
  link: RelationDefinition,
  relatedType: GraphQLObjectType,
  relatedFieldName: string,
  relatedSchemaName: string,
  isFrom: boolean,
): GraphQLObjectType {
  // Direction-specific edge type names to avoid field conflicts
  const ownerPascal = isFrom ? toPascalCase(link.from) : toPascalCase(link.to);
  const otherPascal = isFrom ? toPascalCase(link.to) : toPascalCase(link.from);
  const edgeTypeName = `${ownerPascal}${otherPascal}Edge`;

  const cached = edgeTypeCache.get(edgeTypeName);
  if (cached) return cached;

  const properties = link.properties ?? {};
  const edgeType = new GraphQLObjectType({
    name: edgeTypeName,
    description: `Edge type for ${link.name} M:N relationship with properties`,
    fields: () => {
      const fields: Record<string, { type: GraphQLOutputType; description?: string }> = {};

      // Related record field
      fields[relatedFieldName] = {
        type: new GraphQLNonNull(relatedType),
        description: `Related ${relatedSchemaName} record`,
      };

      // Property fields from junction table
      for (const [propName, propDef] of Object.entries(properties)) {
        const gqlType = mapPropertyToGraphQLType(propDef);
        const camelName = toCamelCase(propName);
        fields[camelName] = {
          type: propDef.required ? new GraphQLNonNull(gqlType) : gqlType,
          description: propDef.description ?? propDef.label,
        };
      }

      return fields;
    },
  });

  edgeTypeCache.set(edgeTypeName, edgeType);
  return edgeType;
}

// ── Link field builder ─────────────────────────────────────

/** Link field definition returned by buildLinkFields */
export type LinkFieldDef = {
  type: GraphQLOutputType;
  description?: string;
  resolve: (
    obj: Record<string, unknown>,
    args: Record<string, unknown>,
    ctx: LinkResolverContext,
  ) => Promise<unknown>;
};

/**
 * Compute link-based relation fields for a given schema.
 *
 * FK naming convention (matches schema-to-drizzle.ts):
 * - many_to_one / one_to_one: `{to}_id` column on `from` table
 * - one_to_many: `{from}_id` column on `to` table
 * - many_to_many: junction table `_link_{name}` with `{from}_id` and `{to}_id`
 */
export function buildLinkFields(
  schemaName: string,
  links: RelationDefinition[],
  typeMap: Map<string, GraphQLObjectType>,
  logger: Logger,
): Record<string, LinkFieldDef> {
  const fields: Record<string, LinkFieldDef> = {};

  for (const link of links) {
    const isFrom = link.from === schemaName;
    const isTo = link.to === schemaName;
    if (!isFrom && !isTo) continue;

    switch (link.cardinality) {
      case "many_to_one": {
        if (isFrom) {
          // From side: singular field pointing to the "to" schema
          // FK column: `{to}_id` on from table
          const relatedType = typeMap.get(link.to);
          if (!relatedType) break;
          const fkColumn = `${link.to}_id`;
          const fieldName = link.to;
          const label = link.label?.from;
          fields[fieldName] = {
            type: relatedType,
            description: label ?? `Related ${link.to}`,
            resolve: async (obj, _args, ctx) => {
              const fkValue = obj[fkColumn] as string | undefined;
              if (!fkValue || (!ctx.dataProvider && !ctx.linkLoaders)) return null;
              try {
                const record = await fetchOne(link.to, fkValue, ctx);
                return record ? applyLinkMasking(record, link.to, ctx) : null;
              } catch (err) {
                logger.error(
                  `[link-resolver] Failed to resolve ${link.name} (many_to_one from): ${err}`,
                );
                return null;
              }
            },
          };
        }
        if (isTo) {
          // To side (reverse): plural field listing records from "from" schema
          const relatedType = typeMap.get(link.from);
          if (!relatedType) break;
          const fkColumn = `${link.to}_id`;
          const fieldName = `${link.from}s`;
          const label = link.label?.to;
          fields[fieldName] = {
            type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(relatedType))),
            description: label ?? `Related ${link.from} records`,
            resolve: async (obj, _args, ctx) => {
              const id = obj.id as string;
              if (!id || (!ctx.dataProvider && !ctx.linkLoaders)) return [];
              try {
                const records = await fetchByFK(link.from, fkColumn, id, ctx);
                return applyLinkMaskingArray(records, link.from, ctx);
              } catch (err) {
                logger.error(
                  `[link-resolver] Failed to resolve ${link.name} (many_to_one to): ${err}`,
                );
                return [];
              }
            },
          };
        }
        break;
      }

      case "one_to_many": {
        if (isFrom) {
          // From side: plural field listing records from "to" schema
          const relatedType = typeMap.get(link.to);
          if (!relatedType) break;
          const fkColumn = `${link.from}_id`;
          const fieldName = `${link.to}s`;
          const label = link.label?.from;
          fields[fieldName] = {
            type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(relatedType))),
            description: label ?? `Related ${link.to} records`,
            resolve: async (obj, _args, ctx) => {
              const id = obj.id as string;
              if (!id || (!ctx.dataProvider && !ctx.linkLoaders)) return [];
              try {
                const records = await fetchByFK(link.to, fkColumn, id, ctx);
                return applyLinkMaskingArray(records, link.to, ctx);
              } catch (err) {
                logger.error(
                  `[link-resolver] Failed to resolve ${link.name} (one_to_many from): ${err}`,
                );
                return [];
              }
            },
          };
        }
        if (isTo) {
          // To side (reverse): singular field pointing to "from" schema
          const relatedType = typeMap.get(link.from);
          if (!relatedType) break;
          const fkColumn = `${link.from}_id`;
          const fieldName = link.from;
          const label = link.label?.to;
          fields[fieldName] = {
            type: relatedType,
            description: label ?? `Related ${link.from}`,
            resolve: async (obj, _args, ctx) => {
              const fkValue = obj[fkColumn] as string | undefined;
              if (!fkValue || (!ctx.dataProvider && !ctx.linkLoaders)) return null;
              try {
                const record = await fetchOne(link.from, fkValue, ctx);
                return record ? applyLinkMasking(record, link.from, ctx) : null;
              } catch (err) {
                logger.error(
                  `[link-resolver] Failed to resolve ${link.name} (one_to_many to): ${err}`,
                );
                return null;
              }
            },
          };
        }
        break;
      }

      case "one_to_one": {
        if (isFrom) {
          const relatedType = typeMap.get(link.to);
          if (!relatedType) break;
          const fkColumn = `${link.to}_id`;
          const fieldName = link.to;
          const label = link.label?.from;
          fields[fieldName] = {
            type: relatedType,
            description: label ?? `Related ${link.to}`,
            resolve: async (obj, _args, ctx) => {
              const fkValue = obj[fkColumn] as string | undefined;
              if (!fkValue || (!ctx.dataProvider && !ctx.linkLoaders)) return null;
              try {
                const record = await fetchOne(link.to, fkValue, ctx);
                return record ? applyLinkMasking(record, link.to, ctx) : null;
              } catch (err) {
                logger.error(
                  `[link-resolver] Failed to resolve ${link.name} (one_to_one from): ${err}`,
                );
                return null;
              }
            },
          };
        }
        if (isTo) {
          // Reverse: query from table for record where {to}_id = this.id
          const relatedType = typeMap.get(link.from);
          if (!relatedType) break;
          const fkColumn = `${link.to}_id`;
          const fieldName = link.from;
          const label = link.label?.to;
          fields[fieldName] = {
            type: relatedType,
            description: label ?? `Related ${link.from}`,
            resolve: async (obj, _args, ctx) => {
              const id = obj.id as string;
              if (!id || (!ctx.dataProvider && !ctx.linkLoaders)) return null;
              try {
                const results = await fetchByFK(link.from, fkColumn, id, ctx);
                const first = results[0] ?? null;
                return first ? applyLinkMasking(first, link.from, ctx) : null;
              } catch (err) {
                logger.error(
                  `[link-resolver] Failed to resolve ${link.name} (one_to_one to): ${err}`,
                );
                return null;
              }
            },
          };
        }
        break;
      }

      case "many_to_many": {
        // Both sides get a plural field. Resolve via junction table `_link_{name}`.
        const otherSchema = isFrom ? link.to : link.from;
        const relatedType = typeMap.get(otherSchema);
        if (!relatedType) break;

        const junctionTable = `_link_${link.name}`;
        const thisFkCol = isFrom ? `${link.from}_id` : `${link.to}_id`;
        const otherFkCol = isFrom ? `${link.to}_id` : `${link.from}_id`;
        const hasProperties = link.properties && Object.keys(link.properties).length > 0;

        if (hasProperties) {
          // M:N with properties: generate Edge type field (e.g. productEdges)
          const relatedFieldName = toCamelCase(otherSchema);
          const edgeType = getOrCreateEdgeType(
            link,
            relatedType,
            relatedFieldName,
            otherSchema,
            isFrom,
          );
          const fieldName = `${relatedFieldName}Edges`;
          const label = isFrom ? link.label?.from : link.label?.to;

          fields[fieldName] = {
            type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(edgeType))),
            description: label ?? `Related ${otherSchema} edges with properties`,
            resolve: async (obj, _args, ctx) => {
              const id = obj.id as string;
              if (!id || (!ctx.dataProvider && !ctx.linkLoaders)) return [];
              try {
                // Query junction table for matching rows
                const junctionRows = await fetchByFK(junctionTable, thisFkCol, id, ctx);
                if (junctionRows.length === 0) return [];

                // Build edge objects: related record + junction properties
                const edges: Record<string, unknown>[] = [];
                for (const jRow of junctionRows) {
                  const relatedId = jRow[otherFkCol] as string;
                  if (!relatedId) continue;
                  const record = await fetchOne(otherSchema, relatedId, ctx);
                  if (!record) continue;
                  const maskedRecord = applyLinkMasking(record, otherSchema, ctx);

                  // Build edge: related record + property fields (camelCase keys)
                  const edge: Record<string, unknown> = {
                    [relatedFieldName]: maskedRecord,
                  };
                  for (const propName of Object.keys(link.properties ?? {})) {
                    const camelName = toCamelCase(propName);
                    edge[camelName] = jRow[propName] ?? null;
                  }
                  edges.push(edge);
                }
                return edges;
              } catch (err) {
                logger.error(
                  `[link-resolver] Failed to resolve ${link.name} (many_to_many edges): ${err}`,
                );
                return [];
              }
            },
          };
        } else {
          // M:N without properties: plain array of related records
          const fieldName = `${otherSchema}s`;
          const label = isFrom ? link.label?.from : link.label?.to;

          fields[fieldName] = {
            type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(relatedType))),
            description: label ?? `Related ${otherSchema} records`,
            resolve: async (obj, _args, ctx) => {
              const id = obj.id as string;
              if (!id || (!ctx.dataProvider && !ctx.linkLoaders)) return [];
              try {
                // Query junction table for matching rows
                const junctionRows = await fetchByFK(junctionTable, thisFkCol, id, ctx);
                // Collect related IDs from junction rows
                const relatedIds = junctionRows
                  .map((row) => row[otherFkCol] as string)
                  .filter(Boolean);
                if (relatedIds.length === 0) return [];
                // Batch-fetch related records via DataLoader (or direct calls)
                const results = await Promise.all(
                  relatedIds.map((relatedId) => fetchOne(otherSchema, relatedId, ctx)),
                );
                const filtered = results.filter(Boolean) as Record<string, unknown>[];
                return applyLinkMaskingArray(filtered, otherSchema, ctx);
              } catch (err) {
                logger.error(
                  `[link-resolver] Failed to resolve ${link.name} (many_to_many): ${err}`,
                );
                return [];
              }
            },
          };
        }
        break;
      }
    }
  }

  return fields;
}

/**
 * Clear the edge type cache. Useful in tests to avoid type name collisions
 * across test suites that build schemas with different link configurations.
 */
export function clearEdgeTypeCache(): void {
  edgeTypeCache.clear();
}
