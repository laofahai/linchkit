/**
 * Link-based relation field generation for GraphQL.
 *
 * Generates resolver fields that navigate Link relationships (many_to_one,
 * one_to_many, one_to_one, many_to_many) with data masking support.
 *
 * Extracted from schema-to-graphql.ts to keep each module focused.
 */

import type {
  Actor,
  DataProvider,
  LinkDefinition,
  Logger,
  MaskRecordOptions,
  PermissionGroupDefinition,
  SchemaDefinition,
} from "@linchkit/core";
import { maskRecord } from "@linchkit/core/server";
import {
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  type GraphQLOutputType,
} from "graphql";

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
  schemaMap?: Map<string, SchemaDefinition>;
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
  links: LinkDefinition[],
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
              if (!fkValue || !ctx.dataProvider) return null;
              try {
                const record = await ctx.dataProvider.get(link.to, fkValue, {
                  tenantId: ctx.tenantId,
                });
                return record
                  ? applyLinkMasking(record as Record<string, unknown>, link.to, ctx)
                  : null;
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
              if (!id || !ctx.dataProvider) return [];
              try {
                const records = await ctx.dataProvider.query(
                  link.from,
                  { [fkColumn]: id },
                  { tenantId: ctx.tenantId },
                );
                return applyLinkMaskingArray(records as Record<string, unknown>[], link.from, ctx);
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
              if (!id || !ctx.dataProvider) return [];
              try {
                const records = await ctx.dataProvider.query(
                  link.to,
                  { [fkColumn]: id },
                  { tenantId: ctx.tenantId },
                );
                return applyLinkMaskingArray(records as Record<string, unknown>[], link.to, ctx);
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
              if (!fkValue || !ctx.dataProvider) return null;
              try {
                const record = await ctx.dataProvider.get(link.from, fkValue, {
                  tenantId: ctx.tenantId,
                });
                return record
                  ? applyLinkMasking(record as Record<string, unknown>, link.from, ctx)
                  : null;
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
              if (!fkValue || !ctx.dataProvider) return null;
              try {
                const record = await ctx.dataProvider.get(link.to, fkValue, {
                  tenantId: ctx.tenantId,
                });
                return record
                  ? applyLinkMasking(record as Record<string, unknown>, link.to, ctx)
                  : null;
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
              if (!id || !ctx.dataProvider) return null;
              try {
                const results = await ctx.dataProvider.query(
                  link.from,
                  { [fkColumn]: id },
                  { tenantId: ctx.tenantId },
                );
                const first = results[0] ?? null;
                return first
                  ? applyLinkMasking(first as Record<string, unknown>, link.from, ctx)
                  : null;
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

        const fieldName = `${otherSchema}s`;
        const label = isFrom ? link.label?.from : link.label?.to;
        const junctionTable = `_link_${link.name}`;
        const thisFkCol = isFrom ? `${link.from}_id` : `${link.to}_id`;
        const otherFkCol = isFrom ? `${link.to}_id` : `${link.from}_id`;

        fields[fieldName] = {
          type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(relatedType))),
          description: label ?? `Related ${otherSchema} records`,
          resolve: async (obj, _args, ctx) => {
            const id = obj.id as string;
            const dp = ctx.dataProvider;
            if (!id || !dp) return [];
            try {
              // Query junction table for matching rows
              const junctionRows = await dp.query(
                junctionTable,
                { [thisFkCol]: id },
                { tenantId: ctx.tenantId },
              );
              // Fetch each related record by ID
              const relatedIds = junctionRows
                .map((row) => row[otherFkCol] as string)
                .filter(Boolean);
              if (relatedIds.length === 0) return [];
              const results = await Promise.all(
                relatedIds.map(async (relatedId) => {
                  try {
                    return await dp.get(otherSchema, relatedId, {
                      tenantId: ctx.tenantId,
                    });
                  } catch (err) {
                    logger.error(
                      `[link-resolver] Failed to fetch ${otherSchema}#${relatedId} in ${link.name}: ${err}`,
                    );
                    return null;
                  }
                }),
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
        break;
      }
    }
  }

  return fields;
}
