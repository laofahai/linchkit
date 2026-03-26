/**
 * Calendar utility functions — pure logic for date grouping and field detection.
 */

import type { SchemaDefinition } from "@linchkit/core/types";
import { format, parseISO } from "date-fns";

/** Parse a date value from a record field. Handles ISO strings, Date objects, and timestamps. */
export function parseDateValue(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value === "string") {
    try {
      return parseISO(value);
    } catch {
      return null;
    }
  }
  if (typeof value === "number") return new Date(value);
  return null;
}

/** Detect the first text-like field name from schema to use as title fallback. */
export function detectTitleField(schema: SchemaDefinition): string {
  const textFields = Object.entries(schema.fields).filter(
    ([, def]) => def.type === "string" || def.type === "text",
  );
  // Prefer fields named "title", "name", "label", "subject"
  const preferred = ["title", "name", "label", "subject"];
  for (const p of preferred) {
    if (textFields.some(([k]) => k === p)) return p;
  }
  return textFields[0]?.[0] ?? "id";
}

/**
 * Group records by date key (yyyy-MM-dd) using the given date field.
 * Returns a Map of date key -> records.
 */
export function groupRecordsByDate(
  records: Record<string, unknown>[],
  dateField: string,
): Map<string, Record<string, unknown>[]> {
  const map = new Map<string, Record<string, unknown>[]>();
  for (const record of records) {
    const dateVal = parseDateValue(record[dateField]);
    if (!dateVal) continue;
    const key = format(dateVal, "yyyy-MM-dd");
    const existing = map.get(key);
    if (existing) {
      existing.push(record);
    } else {
      map.set(key, [record]);
    }
  }
  return map;
}

/** Find the first date/datetime field in schema for calendar view. */
export function findDateField(
  schemaFields: Record<string, { type?: string }>,
): string | null {
  const dateFieldNames = Object.entries(schemaFields)
    .filter(([, def]) => def.type === "date" || def.type === "datetime")
    .map(([name]) => name);

  // Prefer fields with meaningful names
  const preferred = ["due_date", "date", "scheduled_at", "submitted_at", "requested_at", "created_at"];
  for (const p of preferred) {
    if (dateFieldNames.includes(p)) return p;
  }
  return dateFieldNames[0] ?? null;
}
