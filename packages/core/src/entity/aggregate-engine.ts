/**
 * Aggregate Engine (spec 48)
 *
 * Cross-schema aggregation via Link system: SUM, COUNT, AVG, MIN, MAX.
 * Queries related records through the data provider and computes aggregate values.
 */

import type { DataProvider } from "../engine/action-engine";
import type { RelationDefinition } from "../types/relation";
import type { AggregateDerived } from "./safe-evaluator";

/**
 * Resolve an aggregate derived field value by querying related records via the data provider.
 *
 * Determines the FK column from the link definition and queries all related records,
 * then computes the aggregate operation (sum, count, avg, min, max).
 *
 * @param derived - The aggregate derived configuration
 * @param record - The parent record (must have an `id` field)
 * @param link - The link definition connecting parent to child schema
 * @param dataProvider - Data provider for querying related records
 * @returns The aggregated value
 */
export async function resolveAggregateValue(
  derived: AggregateDerived,
  record: Record<string, unknown>,
  link: RelationDefinition,
  dataProvider: DataProvider,
): Promise<number> {
  const parentId = record.id as string;
  if (!parentId) return 0;

  // Determine the FK column name and query direction based on link cardinality.
  // The parent schema is on the side that "has" the aggregate (i.e., the "from" side
  // of one_to_many, or the "to" side of many_to_one).
  const childSchema = derived.source.entity;
  let fkColumn: string;

  if (link.from === childSchema) {
    // Link: child → parent, FK is on the child table: `{parent}_id`
    fkColumn = `${link.to}_id`;
  } else {
    // Link: parent → child, FK is on the child table: `{parent}_id`
    fkColumn = `${link.from}_id`;
  }

  // Build filter: FK column matches parent ID + any user-specified filter
  const filter: Record<string, unknown> = { [fkColumn]: parentId };
  if (derived.source.filter) {
    Object.assign(filter, derived.source.filter);
  }

  const relatedRecords = await dataProvider.query(childSchema, filter);

  return computeAggregate(derived.op, derived.field, relatedRecords);
}

/**
 * Compute an aggregate operation on an array of records.
 */
export function computeAggregate(
  op: AggregateDerived["op"],
  field: string | undefined,
  records: Array<Record<string, unknown>>,
): number {
  if (op === "count") {
    return records.length;
  }

  if (!field) return 0;

  const values = records
    .map((r) => {
      const v = r[field];
      if (v === null || v === undefined) return undefined;
      const num = Number(v);
      return Number.isNaN(num) ? undefined : num;
    })
    .filter((v): v is number => v !== undefined);

  if (values.length === 0) return 0;

  switch (op) {
    case "sum":
      return values.reduce((a, b) => a + b, 0);
    case "avg":
      return values.reduce((a, b) => a + b, 0) / values.length;
    case "min":
      return Math.min(...values);
    case "max":
      return Math.max(...values);
    default:
      return 0;
  }
}
