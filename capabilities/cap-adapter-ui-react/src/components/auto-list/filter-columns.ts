/**
 * Bridge: convert a SchemaDefinition's fields into bazza ColumnConfig array.
 *
 * Maps LinchKit field types to bazza ColumnDataType and extracts
 * options / min / max from field definitions + data.
 */

import type { EnumField, FieldDefinition, SchemaDefinition, StateMeta } from "@linchkit/core/types";
import type { LucideIcon } from "lucide-react";
import { CalendarIcon, HashIcon, ListIcon, TextIcon, ToggleLeftIcon, TypeIcon } from "lucide-react";
import { createColumnConfigHelper } from "../data-table-filter/core/filters";
import type { ColumnConfig, ColumnDataType } from "../data-table-filter/core/types";

type DataRow = Record<string, unknown>;

/**
 * Heterogeneous column config array — each element may have a different TType/TVal,
 * so we must erase the inner type parameters. Using Array<ColumnConfig<DataRow, ...>>
 * with a union doesn't work due to variance, so we use an opaque wrapper.
 */
/**
 * Internal heterogeneous config array — each element carries a specific TType/TVal.
 * The public return type is widened via ReadonlyArray<ColumnConfig<DataRow>> so that
 * consumers (useDataTableFilters) can accept it without variance issues.
 */
type MixedColumnConfigs = Array<
  | ColumnConfig<DataRow, "text", string, string>
  | ColumnConfig<DataRow, "number", number, string>
  | ColumnConfig<DataRow, "date", Date, string>
  | ColumnConfig<DataRow, "option", string, string>
>;

/** Maps a LinchKit FieldType to a bazza ColumnDataType, or null if not filterable. */
function mapFieldType(fieldType: string): ColumnDataType | null {
  switch (fieldType) {
    case "string":
    case "text":
      return "text";
    case "number":
      return "number";
    case "date":
    case "datetime":
      return "date";
    case "enum":
    case "state":
      return "option";
    case "boolean":
      return "option"; // Represent boolean as option (true/false)
    default:
      return null;
  }
}

/** Returns an appropriate Lucide icon for a field type. */
function fieldIcon(fieldType: string): LucideIcon {
  switch (fieldType) {
    case "string":
    case "text":
      return TypeIcon;
    case "number":
      return HashIcon;
    case "date":
    case "datetime":
      return CalendarIcon;
    case "enum":
    case "state":
      return ListIcon;
    case "boolean":
      return ToggleLeftIcon;
    default:
      return TextIcon;
  }
}

/**
 * Build bazza ColumnConfig[] from a SchemaDefinition.
 *
 * Skips non-filterable field types (computed, json).
 * For enum / state fields, extracts options from field definition or data.
 * For boolean fields, provides true / false options.
 * For number fields, computes min / max from data.
 */
export function buildFilterColumns(
  schema: SchemaDefinition,
  data: DataRow[],
  stateMeta?: Partial<Record<string, StateMeta>>,
  resolveLabel?: (label: string | undefined, fallback: string) => string,
): readonly ColumnConfig<DataRow>[] {
  const resolve = resolveLabel ?? ((l: string | undefined, fb: string) => l ?? fb);
  const helper = createColumnConfigHelper<DataRow>();
  const configs: MixedColumnConfigs = [];

  for (const [fieldName, fieldDef] of Object.entries(schema.fields)) {
    const dataType = mapFieldType(fieldDef.type);
    if (!dataType) continue;

    const displayName = resolve(fieldDef.label, fieldName);
    const icon = fieldIcon(fieldDef.type);

    switch (dataType) {
      case "text": {
        configs.push(
          helper
            .text()
            .id(fieldName)
            .accessor((row) => String(row[fieldName] ?? ""))
            .displayName(displayName)
            .icon(icon)
            .build(),
        );
        break;
      }
      case "number": {
        // Compute min / max from data
        const values = data
          .map((row) => row[fieldName])
          .filter((v): v is number => typeof v === "number" && !Number.isNaN(v));
        const min = values.length > 0 ? Math.min(...values) : 0;
        const max = values.length > 0 ? Math.max(...values) : 100;

        configs.push(
          helper
            .number()
            .id(fieldName)
            .accessor((row) => (typeof row[fieldName] === "number" ? row[fieldName] : 0))
            .displayName(displayName)
            .icon(icon)
            .min(min)
            .max(max)
            .build(),
        );
        break;
      }
      case "date": {
        configs.push(
          helper
            .date()
            .id(fieldName)
            .accessor((row) => {
              const v = row[fieldName];
              if (v instanceof Date) return v;
              if (typeof v === "string" || typeof v === "number") return new Date(v);
              return new Date();
            })
            .displayName(displayName)
            .icon(icon)
            .build(),
        );
        break;
      }
      case "option": {
        const options = extractOptions(fieldDef, data, fieldName, stateMeta, resolve);
        configs.push(
          helper
            .option()
            .id(fieldName)
            .accessor((row) => String(row[fieldName] ?? ""))
            .displayName(displayName)
            .icon(icon)
            .options(options)
            .build(),
        );
        break;
      }
    }
  }

  // The union members carry specific TVal (string | number | Date) which is
  // invariant in ColumnConfig. We safely widen here because consumers only
  // read the accessor and metadata — they never narrow on TVal.
  return configs as unknown as readonly ColumnConfig<DataRow>[];
}

/** Extract ColumnOption[] from a FieldDefinition. Uses stateMeta for state fields when available, falls back to unique data values. */
function extractOptions(
  fieldDef: FieldDefinition,
  data: DataRow[],
  fieldName: string,
  stateMeta?: Partial<Record<string, StateMeta>>,
  resolve: (label: string | undefined, fallback: string) => string = (l, fb) => l ?? fb,
): { label: string; value: string }[] {
  if (fieldDef.type === "enum") {
    return (fieldDef as EnumField).options.map((o) => ({
      value: o.value,
      label: resolve(o.label, o.value),
    }));
  }
  if (fieldDef.type === "state") {
    // Prefer state machine meta (complete list of states with labels)
    if (stateMeta && Object.keys(stateMeta).length > 0) {
      return Object.entries(stateMeta).map(([value, meta]) => ({
        value,
        label: resolve(meta?.label, value),
      }));
    }
    // Fallback: derive unique values from data
    const unique = new Set<string>();
    for (const row of data) {
      const v = row[fieldName];
      if (typeof v === "string" && v) unique.add(v);
    }
    return Array.from(unique).map((v) => ({ value: v, label: v }));
  }
  if (fieldDef.type === "boolean") {
    return [
      { value: "true", label: "Yes" },
      { value: "false", label: "No" },
    ];
  }
  return [];
}
