/**
 * Cardinality-specific handler functions for relation field generation.
 *
 * Each handler adds the appropriate GraphQL fields for one cardinality type
 * (many_to_one, one_to_many, one_to_one, many_to_many).
 *
 * Extracted from relation-resolvers.ts for file size management.
 */

import type { Logger, RelationDefinition } from "@linchkit/core";
import { GraphQLList, GraphQLNonNull, type GraphQLObjectType } from "graphql";
import type { RelationFieldDef } from "./relation-resolvers";
import {
  applyRelationMasking,
  applyRelationMaskingBatch,
  fetchByFK,
  fetchOne,
  getOrCreateEdgeType,
  toCamelCase,
} from "./relation-resolvers";

// ── Resolver factories ────────────────────────────────────

/** Create a resolver that reads an FK column from obj, fetches one record */
function singularFKResolver(
  relation: RelationDefinition,
  fkColumn: string,
  targetSchema: string,
  logTag: string,
  logger: Logger,
): RelationFieldDef["resolve"] {
  return async (obj, _args, ctx) => {
    const fkValue = obj[fkColumn] as string | undefined;
    if (!fkValue || (!ctx.dataProvider && !ctx.relationLoaders)) return null;
    try {
      const record = await fetchOne(targetSchema, fkValue, ctx);
      return record ? applyRelationMasking(record, targetSchema, ctx) : null;
    } catch (err) {
      logger.error(`[relation-resolver] Failed to resolve ${relation.name} (${logTag}): ${err}`);
      return null;
    }
  };
}

/** Create a resolver that uses obj.id to fetch many records via FK */
function pluralFKResolver(
  relation: RelationDefinition,
  fkColumn: string,
  targetSchema: string,
  logTag: string,
  logger: Logger,
): RelationFieldDef["resolve"] {
  return async (obj, _args, ctx) => {
    const id = obj.id as string;
    if (!id || (!ctx.dataProvider && !ctx.relationLoaders)) return [];
    try {
      const records = await fetchByFK(targetSchema, fkColumn, id, ctx);
      return applyRelationMaskingBatch(records, targetSchema, ctx);
    } catch (err) {
      logger.error(`[relation-resolver] Failed to resolve ${relation.name} (${logTag}): ${err}`);
      return [];
    }
  };
}

/** Create a resolver that uses obj.id, fetches via FK, returns first result */
function singularReverseFKResolver(
  relation: RelationDefinition,
  fkColumn: string,
  targetSchema: string,
  logTag: string,
  logger: Logger,
): RelationFieldDef["resolve"] {
  return async (obj, _args, ctx) => {
    const id = obj.id as string;
    if (!id || (!ctx.dataProvider && !ctx.relationLoaders)) return null;
    try {
      const results = await fetchByFK(targetSchema, fkColumn, id, ctx);
      const first = results[0] ?? null;
      return first ? applyRelationMasking(first, targetSchema, ctx) : null;
    } catch (err) {
      logger.error(`[relation-resolver] Failed to resolve ${relation.name} (${logTag}): ${err}`);
      return null;
    }
  };
}

/** Create a resolver for M:N with junction-table properties (edge type) */
function manyToManyEdgeResolver(
  relation: RelationDefinition,
  junctionTable: string,
  thisFkCol: string,
  otherFkCol: string,
  otherSchema: string,
  relatedFieldName: string,
  logger: Logger,
): RelationFieldDef["resolve"] {
  return async (obj, _args, ctx) => {
    const id = obj.id as string;
    if (!id || (!ctx.dataProvider && !ctx.relationLoaders)) return [];
    try {
      const junctionRows = await fetchByFK(junctionTable, thisFkCol, id, ctx);
      if (junctionRows.length === 0) return [];
      const edges: Record<string, unknown>[] = [];
      for (const jRow of junctionRows) {
        const relatedId = jRow[otherFkCol] as string;
        if (!relatedId) continue;
        const record = await fetchOne(otherSchema, relatedId, ctx);
        if (!record) continue;
        const edge: Record<string, unknown> = {
          [relatedFieldName]: applyRelationMasking(record, otherSchema, ctx),
        };
        for (const propName of Object.keys(relation.properties ?? {})) {
          edge[toCamelCase(propName)] = jRow[propName] ?? null;
        }
        edges.push(edge);
      }
      return edges;
    } catch (err) {
      logger.error(
        `[relation-resolver] Failed to resolve ${relation.name} (many_to_many edges): ${err}`,
      );
      return [];
    }
  };
}

/** Create a resolver for M:N without properties (plain array) */
function manyToManyPlainResolver(
  relation: RelationDefinition,
  junctionTable: string,
  thisFkCol: string,
  otherFkCol: string,
  otherSchema: string,
  logger: Logger,
): RelationFieldDef["resolve"] {
  return async (obj, _args, ctx) => {
    const id = obj.id as string;
    if (!id || (!ctx.dataProvider && !ctx.relationLoaders)) return [];
    try {
      const junctionRows = await fetchByFK(junctionTable, thisFkCol, id, ctx);
      const relatedIds = junctionRows.map((row) => row[otherFkCol] as string).filter(Boolean);
      if (relatedIds.length === 0) return [];
      const results = await Promise.all(
        relatedIds.map((relatedId) => fetchOne(otherSchema, relatedId, ctx)),
      );
      return applyRelationMaskingBatch(
        results.filter(Boolean) as Record<string, unknown>[],
        otherSchema,
        ctx,
      );
    } catch (err) {
      logger.error(`[relation-resolver] Failed to resolve ${relation.name} (many_to_many): ${err}`);
      return [];
    }
  };
}

// ── Cardinality handlers ──────────────────────────────────

/** Arguments passed to each cardinality handler */
export interface CardinalityHandlerArgs {
  relation: RelationDefinition;
  isFrom: boolean;
  isTo: boolean;
  typeMap: Map<string, GraphQLObjectType>;
  fields: Record<string, RelationFieldDef>;
  logger: Logger;
}

export type CardinalityHandler = (args: CardinalityHandlerArgs) => void;

function handleManyToOne(args: CardinalityHandlerArgs): void {
  const { relation, isFrom, isTo, typeMap, fields, logger } = args;
  if (isFrom) {
    const relatedType = typeMap.get(relation.to);
    if (!relatedType) return;
    const fkColumn = `${relation.fromName}_id`;
    fields[toCamelCase(relation.fromName)] = {
      type: relatedType,
      description: relation.label?.from ?? `Related ${relation.to}`,
      resolve: singularFKResolver(relation, fkColumn, relation.to, "many_to_one from", logger),
    };
  }
  if (isTo) {
    const relatedType = typeMap.get(relation.from);
    if (!relatedType) return;
    const fkColumn = `${relation.fromName}_id`;
    fields[toCamelCase(relation.toName)] = {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(relatedType))),
      description: relation.label?.to ?? `Related ${relation.from} records`,
      resolve: pluralFKResolver(relation, fkColumn, relation.from, "many_to_one to", logger),
    };
  }
}

function handleOneToMany(args: CardinalityHandlerArgs): void {
  const { relation, isFrom, isTo, typeMap, fields, logger } = args;
  if (isFrom) {
    const relatedType = typeMap.get(relation.to);
    if (!relatedType) return;
    const fkColumn = `${relation.toName}_id`;
    fields[toCamelCase(relation.fromName)] = {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(relatedType))),
      description: relation.label?.from ?? `Related ${relation.to} records`,
      resolve: pluralFKResolver(relation, fkColumn, relation.to, "one_to_many from", logger),
    };
  }
  if (isTo) {
    const relatedType = typeMap.get(relation.from);
    if (!relatedType) return;
    const fkColumn = `${relation.toName}_id`;
    fields[toCamelCase(relation.toName)] = {
      type: relatedType,
      description: relation.label?.to ?? `Related ${relation.from}`,
      resolve: singularFKResolver(relation, fkColumn, relation.from, "one_to_many to", logger),
    };
  }
}

function handleOneToOne(args: CardinalityHandlerArgs): void {
  const { relation, isFrom, isTo, typeMap, fields, logger } = args;
  if (isFrom) {
    const relatedType = typeMap.get(relation.to);
    if (!relatedType) return;
    const fkColumn = `${relation.fromName}_id`;
    fields[toCamelCase(relation.fromName)] = {
      type: relatedType,
      description: relation.label?.from ?? `Related ${relation.to}`,
      resolve: singularFKResolver(relation, fkColumn, relation.to, "one_to_one from", logger),
    };
  }
  if (isTo) {
    const relatedType = typeMap.get(relation.from);
    if (!relatedType) return;
    const fkColumn = `${relation.fromName}_id`;
    fields[toCamelCase(relation.toName)] = {
      type: relatedType,
      description: relation.label?.to ?? `Related ${relation.from}`,
      resolve: singularReverseFKResolver(
        relation,
        fkColumn,
        relation.from,
        "one_to_one to",
        logger,
      ),
    };
  }
}

function handleManyToMany(args: CardinalityHandlerArgs): void {
  const { relation, isFrom, typeMap, fields, logger } = args;
  const otherSchema = isFrom ? relation.to : relation.from;
  const relatedType = typeMap.get(otherSchema);
  if (!relatedType) return;

  const junctionTable = `_rel_${relation.name}`;
  const thisFkCol = isFrom ? `${relation.from}_id` : `${relation.to}_id`;
  const otherFkCol = isFrom ? `${relation.to}_id` : `${relation.from}_id`;
  const semanticName = isFrom ? relation.fromName : relation.toName;
  const label = isFrom ? relation.label?.from : relation.label?.to;
  const hasProperties = relation.properties && Object.keys(relation.properties).length > 0;

  if (hasProperties) {
    const relatedFieldName = toCamelCase(semanticName);
    const edgeType = getOrCreateEdgeType(
      relation,
      relatedType,
      relatedFieldName,
      otherSchema,
      isFrom,
    );
    fields[`${relatedFieldName}Edges`] = {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(edgeType))),
      description: label ?? `Related ${otherSchema} edges with properties`,
      resolve: manyToManyEdgeResolver(
        relation,
        junctionTable,
        thisFkCol,
        otherFkCol,
        otherSchema,
        relatedFieldName,
        logger,
      ),
    };
  } else {
    fields[toCamelCase(semanticName)] = {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(relatedType))),
      description: label ?? `Related ${otherSchema} records`,
      resolve: manyToManyPlainResolver(
        relation,
        junctionTable,
        thisFkCol,
        otherFkCol,
        otherSchema,
        logger,
      ),
    };
  }
}

/** Handler map keyed by cardinality type */
export const cardinalityHandlers: Record<string, CardinalityHandler> = {
  many_to_one: handleManyToOne,
  one_to_many: handleOneToMany,
  one_to_one: handleOneToOne,
  many_to_many: handleManyToMany,
};
