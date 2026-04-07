/**
 * Relation-based field generation for GraphQL.
 *
 * Generates resolver fields that navigate Relation relationships (many_to_one,
 * one_to_many, one_to_one, many_to_many) with data masking support.
 *
 * Uses DataLoader for batched loading to avoid N+1 query problems.
 *
 * Extracted from schema-to-graphql.ts to keep each module focused.
 * Cardinality-specific handlers live in cardinality-handlers.ts.
 */

import type {
  Actor,
  DataProvider,
  EntityDefinition,
  FieldDefinition,
  Logger,
  MaskRecordOptions,
  PermissionGroupDefinition,
  RelationDefinition,
} from "@linchkit/core";
import { maskRecord } from "@linchkit/core/server";
import {
  GraphQLBoolean,
  GraphQLFloat,
  GraphQLNonNull,
  GraphQLObjectType,
  type GraphQLOutputType,
  GraphQLString,
} from "graphql";
import { cardinalityHandlers } from "./cardinality-handlers";
import type { RelationDataLoaders } from "./relation-dataloader";

// ── Types ──────────────────────────────────────────────────

/** Context for resolving relation fields */
export interface RelationResolverContext {
  /** Data provider for fetching related records (optional — resolvers degrade gracefully) */
  dataProvider?: DataProvider;
  /** Tenant ID for data isolation */
  tenantId?: string;
  /** Authenticated actor for permission-based data masking */
  actor?: Actor;
  /** Permission groups for data masking unmask checks */
  permissionGroups?: PermissionGroupDefinition[];
  /** Entity definitions map for data masking lookups */
  entityMap?: Map<string, EntityDefinition>;
  /** Per-request DataLoaders for batched relation resolution (created in context factory) */
  relationLoaders?: RelationDataLoaders;
}

// ── Masking helpers ────────────────────────────────────────

/** Field types whose masked values cannot be represented as strings in GraphQL (must become null) */
const NON_STRING_FIELD_TYPES = new Set(["number", "boolean", "date", "datetime", "json"]);

/**
 * Apply data masking to a single record using context actor and permissions.
 * Returns the masked record with non-string masked fields coerced to null.
 */
export function applyRelationMasking(
  record: Record<string, unknown>,
  entityName: string,
  ctx: RelationResolverContext,
): Record<string, unknown> {
  if (!ctx.actor || !ctx.entityMap) return record;
  const entityDef = ctx.entityMap.get(entityName);
  if (!entityDef) return record;
  const maskOpts: MaskRecordOptions = {
    actor: ctx.actor,
    groups: ctx.permissionGroups ?? [],
    capabilityName: entityDef.name,
  };
  const masked = maskRecord(record, entityDef, maskOpts);
  // Coerce masked non-string fields to null (GraphQL type mismatch)
  for (const [fieldName, fieldDef] of Object.entries(entityDef.fields)) {
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
export function applyRelationMaskingBatch(
  records: Record<string, unknown>[],
  entityName: string,
  ctx: RelationResolverContext,
): Record<string, unknown>[] {
  return records.map((r) => applyRelationMasking(r, entityName, ctx));
}

// ── DataLoader-aware fetch helpers ─────────────────────────

/**
 * Fetch a single record by ID, using DataLoader when available.
 */
export async function fetchOne(
  schema: string,
  id: string,
  ctx: RelationResolverContext,
): Promise<Record<string, unknown> | null> {
  if (ctx.relationLoaders) {
    return ctx.relationLoaders.getLoader.load({ entity: schema, id, tenantId: ctx.tenantId });
  }
  if (!ctx.dataProvider) return null;
  const record = await ctx.dataProvider.get(schema, id, { tenantId: ctx.tenantId });
  return (record as Record<string, unknown>) ?? null;
}

/**
 * Query records by FK filter, using DataLoader when available.
 */
export async function fetchByFK(
  schema: string,
  fkColumn: string,
  fkValue: string,
  ctx: RelationResolverContext,
): Promise<Record<string, unknown>[]> {
  if (ctx.relationLoaders) {
    return ctx.relationLoaders.queryLoader.load({
      entity: schema,
      fkColumn,
      fkValue,
      tenantId: ctx.tenantId,
    });
  }
  if (!ctx.dataProvider) return [];
  return (await ctx.dataProvider.query(
    schema,
    { [fkColumn]: fkValue },
    { tenantId: ctx.tenantId },
  )) as Record<string, unknown>[];
}

// ── Naming helpers ────────────────────────────────────────

const GRAPHQL_NAME_RE = /^[_A-Za-z][_0-9A-Za-z]*$/;

/** Convert a snake_case name to PascalCase for GraphQL type names */
export function toPascalCase(name: string): string {
  const raw = name
    .split(/[_-]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  const sanitized = raw.replace(/[^_0-9A-Za-z]/g, "");
  return GRAPHQL_NAME_RE.test(sanitized) ? sanitized : `_${sanitized}`;
}

/** Convert a snake_case name to camelCase for GraphQL field names */
export function toCamelCase(name: string): string {
  const pascal = toPascalCase(name);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

// ── Edge type helpers for M:N with properties ──────────────

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
 * Build a GraphQL edge type for an M:N relation with properties.
 * The edge type contains the related record plus all junction table property fields.
 *
 * Direction-specific naming:
 * - From side: SalesOrderProductEdge { product: Product!, quantity: Float!, ... }
 * - To side:   ProductSalesOrderEdge { salesOrder: SalesOrder!, quantity: Float!, ... }
 */
export function getOrCreateEdgeType(
  relation: RelationDefinition,
  relatedType: GraphQLObjectType,
  relatedFieldName: string,
  relatedSchemaName: string,
  isFrom: boolean,
): GraphQLObjectType {
  const ownerPascal = isFrom ? toPascalCase(relation.from) : toPascalCase(relation.to);
  const otherPascal = isFrom ? toPascalCase(relation.to) : toPascalCase(relation.from);
  const edgeTypeName = `${ownerPascal}${otherPascal}Edge`;

  const cached = edgeTypeCache.get(edgeTypeName);
  if (cached) return cached;

  const properties = relation.properties ?? {};
  const edgeType = new GraphQLObjectType({
    name: edgeTypeName,
    description: `Edge type for ${relation.name} M:N relationship with properties`,
    fields: () => {
      const fields: Record<string, { type: GraphQLOutputType; description?: string }> = {};
      fields[relatedFieldName] = {
        type: new GraphQLNonNull(relatedType),
        description: `Related ${relatedSchemaName} record`,
      };
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

// ── Relation field builder ─────────────────────────────────

/** Relation field definition returned by buildRelationFields */
export type RelationFieldDef = {
  type: GraphQLOutputType;
  description?: string;
  resolve: (
    obj: Record<string, unknown>,
    args: Record<string, unknown>,
    ctx: RelationResolverContext,
  ) => Promise<unknown>;
};

/**
 * Compute relation-based fields for a given entity.
 *
 * FK naming convention (matches entity-to-drizzle.ts, uses semantic names):
 * - many_to_one / one_to_one: `{fromName}_id` column on `from` table
 * - one_to_many: `{toName}_id` column on `to` table
 * - many_to_many: junction table `_rel_{name}` with `{from}_id` and `{to}_id`
 */
export function buildRelationFields(
  entityName: string,
  relations: RelationDefinition[],
  typeMap: Map<string, GraphQLObjectType>,
  logger: Logger,
): Record<string, RelationFieldDef> {
  const fields: Record<string, RelationFieldDef> = {};

  for (const relation of relations) {
    if (!relation.fromName || !relation.toName) {
      logger.warn(
        `[relation-resolver] Skipping relation "${relation.name}": missing fromName or toName`,
      );
      continue;
    }
    const isFrom = relation.from === entityName;
    const isTo = relation.to === entityName;
    if (!isFrom && !isTo) continue;

    const handler = cardinalityHandlers[relation.cardinality];
    if (handler) {
      handler({ relation, isFrom, isTo, typeMap, fields, logger });
    }
  }

  return fields;
}

/**
 * Clear the edge type cache. Useful in tests to avoid type name collisions
 * across test suites that build schemas with different relation configurations.
 */
export function clearEdgeTypeCache(): void {
  edgeTypeCache.clear();
}
