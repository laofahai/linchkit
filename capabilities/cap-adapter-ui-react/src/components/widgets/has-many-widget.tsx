/**
 * HasMany widget — Display and input components for has_many relationship fields.
 *
 * Display: Shows count badge in list view, or first few related record labels as chips.
 * Input: Read-only list of related records with an "Add" link to create form.
 */

import { Badge, Button } from "@linchkit/ui-kit/components";
import { Link } from "@tanstack/react-router";
import { useSchemaBundle } from "@/hooks/use-schema-bundle";
import type { WidgetDisplayProps, WidgetInputProps } from "@/lib/widget-registry";
import { getRecordLabel, type RelatedRecord } from "./relation-utils";

export function HasManyDisplay({ value, fieldDef }: WidgetDisplayProps) {
  const targetSchema = (fieldDef as { target?: string }).target ?? "";
  const { bundle: targetBundle } = useSchemaBundle(targetSchema);
  const titleField = targetBundle?.schema.presentation?.titleField;

  // If value is already an array of expanded objects (server-side resolution)
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <span className="text-muted-foreground">--</span>;
    }
    const displayItems = value.slice(0, 3) as RelatedRecord[];
    const remaining = value.length - displayItems.length;

    return (
      <div className="flex flex-wrap items-center gap-1">
        {displayItems.map((item, i) => (
          <Badge key={item.id ?? i} variant="secondary" className="text-xs">
            {getRecordLabel(item, titleField)}
          </Badge>
        ))}
        {remaining > 0 && (
          <Badge variant="outline" className="text-xs">
            +{remaining}
          </Badge>
        )}
      </div>
    );
  }

  // If value is a number (count)
  if (typeof value === "number") {
    return (
      <Badge variant="secondary" className="text-xs">
        {value} {value === 1 ? "item" : "items"}
      </Badge>
    );
  }

  // No data available
  return <span className="text-muted-foreground">--</span>;
}

export function HasManyInput({ value, fieldDef, readonly }: WidgetInputProps) {
  const targetSchema = (fieldDef as { target?: string }).target ?? "";
  const { bundle: targetBundle } = useSchemaBundle(targetSchema);
  const titleField = targetBundle?.schema.presentation?.titleField;

  // Try to extract related records from value
  const records: RelatedRecord[] = Array.isArray(value) ? (value as RelatedRecord[]) : [];

  return (
    <div className="space-y-2">
      {records.length === 0 ? (
        <p className="text-sm text-muted-foreground">No related records</p>
      ) : (
        <div className="space-y-1">
          {records.map((record, i) => (
            <div
              key={record.id ?? i}
              className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm"
            >
              <span className="flex-1">{getRecordLabel(record, titleField)}</span>
              <Link
                to="/schemas/$name/$id"
                params={{ name: targetSchema, id: record.id }}
                className="text-xs text-muted-foreground hover:text-primary"
              >
                View
              </Link>
            </div>
          ))}
        </div>
      )}
      {!readonly && targetSchema && (
        <Link to="/schemas/$name/new" params={{ name: targetSchema }}>
          <Button type="button" variant="outline" size="sm">
            + Add {targetBundle?.schema.label ?? targetSchema}
          </Button>
        </Link>
      )}
    </div>
  );
}
