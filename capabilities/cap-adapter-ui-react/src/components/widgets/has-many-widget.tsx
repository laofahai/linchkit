/**
 * HasMany widget — Display and inline-editable table for one_to_many relationship fields.
 *
 * Display: Shows count badge in list view, or first few related record labels as chips.
 * Input: Inline-editable table with add/delete rows. Child records are managed as virtual
 *        records in client memory until the parent form is saved (Odoo-style).
 */

import {
  Badge,
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@linchkit/ui-kit/components";
import { cn } from "@linchkit/ui-kit/lib/utils";
import { GripVertical, Plus, Trash2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSchemaBundle } from "@/hooks/use-schema-bundle";
import type { WidgetDisplayProps, WidgetInputProps } from "@/lib/widget-registry";
import { getRecordLabel, type RelatedRecord } from "./relation-utils";

/** Generate a virtual temporary ID */
function generateTempId(): string {
  return `_virtual_${crypto.randomUUID()}`;
}

/** Check if a record is a virtual (unsaved) record */
function isVirtualRecord(record: RelatedRecord): boolean {
  return typeof record.id === "string" && record.id.startsWith("_virtual_");
}

/** Infer input type from field definition type */
function getInputType(fieldType: string): string {
  switch (fieldType) {
    case "number":
      return "number";
    case "date":
      return "date";
    case "datetime":
      return "datetime-local";
    default:
      return "text";
  }
}

export function HasManyDisplay({ value, fieldDef }: WidgetDisplayProps) {
  const { t } = useTranslation();
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
        {t("common.item", { count: value })}
      </Badge>
    );
  }

  // No data available
  return <span className="text-muted-foreground">--</span>;
}

export function HasManyInput({ value, onChange, readonly, fieldDef }: WidgetInputProps) {
  const { t } = useTranslation();
  const targetSchema = (fieldDef as { target?: string }).target ?? "";
  const { bundle: targetBundle } = useSchemaBundle(targetSchema);

  // Resolve editable fields from target schema (exclude system fields and FK back-ref)
  const editableFields = useMemo(() => {
    if (!targetBundle?.schema?.fields) return [];
    const systemFields = new Set([
      "id",
      "tenant_id",
      "created_at",
      "updated_at",
      "created_by",
      "updated_by",
      "_version",
      "is_deleted",
    ]);
    return Object.entries(targetBundle.schema.fields)
      .filter(([name, def]) => {
        if (systemFields.has(name)) return false;
        const fieldType = (def as { type?: string }).type;
        // Skip ref fields that point back to the parent (the FK column)
        if (fieldType === "ref" || fieldType === "has_many" || fieldType === "many_to_many")
          return false;
        // Skip state fields
        if (fieldType === "state") return false;
        // Skip derived/computed fields
        if ((def as { derived?: unknown }).derived) return false;
        if (fieldType === "computed") return false;
        return true;
      })
      .map(([name, def]) => ({
        name,
        label: (def as { label?: string }).label ?? name,
        type: (def as { type?: string }).type ?? "string",
        required: !!(def as { required?: boolean }).required,
        options: (def as { options?: Array<{ value: string; label?: string }> }).options,
      }));
  }, [targetBundle]);

  // Records state: merge existing records (from server) with virtual records
  const records: RelatedRecord[] = useMemo(() => {
    if (!Array.isArray(value)) return [];
    return value as RelatedRecord[];
  }, [value]);

  // Track which row is being edited (for existing records)
  const [editingRow, setEditingRow] = useState<string | null>(null);

  const handleAddRow = useCallback(() => {
    const newRecord: RelatedRecord = { id: generateTempId(), _virtual: true };
    // Set defaults for required fields
    for (const field of editableFields) {
      if (field.type === "number") {
        newRecord[field.name] = field.required ? 0 : null;
      } else if (field.type === "boolean") {
        newRecord[field.name] = false;
      } else {
        newRecord[field.name] = "";
      }
    }
    const updated = [...records, newRecord];
    onChange(updated);
  }, [records, editableFields, onChange]);

  const handleDeleteRow = useCallback(
    (recordId: string) => {
      const updated = records.filter((r) => r.id !== recordId);
      onChange(updated);
    },
    [records, onChange],
  );

  const handleCellChange = useCallback(
    (recordId: string, fieldName: string, cellValue: unknown) => {
      const updated = records.map((r) => {
        if (r.id !== recordId) return r;
        return { ...r, [fieldName]: cellValue };
      });
      onChange(updated);
    },
    [records, onChange],
  );

  if (readonly) {
    // Read-only mode: show records as a simple list
    return (
      <div className="space-y-2">
        {records.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("common.noRelatedRecords", "No related records")}
          </p>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  {editableFields.map((field) => (
                    <TableHead key={field.name} className="text-xs">
                      {field.label}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {records.map((record) => (
                  <TableRow key={record.id}>
                    {editableFields.map((field) => (
                      <TableCell key={field.name} className="text-sm">
                        {record[field.name] != null ? String(record[field.name]) : "--"}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    );
  }

  // Editable mode: inline table with add/delete
  return (
    <div className="space-y-2">
      {editableFields.length > 0 && (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                {editableFields.map((field) => (
                  <TableHead key={field.name} className="text-xs">
                    {field.label}
                    {field.required && <span className="text-destructive ml-0.5">*</span>}
                  </TableHead>
                ))}
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {records.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={editableFields.length + 2}
                    className="text-center text-sm text-muted-foreground py-6"
                  >
                    {t("widget.hasManyEmpty", 'No items yet. Click "Add Line" to add one.')}
                  </TableCell>
                </TableRow>
              )}
              {records.map((record) => {
                const isVirtual = isVirtualRecord(record);
                const isEditing = isVirtual || editingRow === record.id;
                return (
                  <TableRow
                    key={record.id}
                    className={cn(
                      "group",
                      isVirtual && "bg-muted/30",
                      !isEditing && "cursor-pointer hover:bg-muted/50",
                    )}
                    onClick={() => {
                      if (!isVirtual && !isEditing) {
                        setEditingRow(record.id);
                      }
                    }}
                  >
                    <TableCell className="w-8 px-1">
                      <GripVertical className="size-3.5 text-muted-foreground/50" />
                    </TableCell>
                    {editableFields.map((field) => (
                      <TableCell key={field.name} className="py-1 px-1">
                        {isEditing ? (
                          <InlineCell
                            value={record[field.name]}
                            fieldType={field.type}
                            options={field.options}
                            onChange={(v) => handleCellChange(record.id, field.name, v)}
                          />
                        ) : (
                          <span className="text-sm px-2">
                            {record[field.name] != null ? String(record[field.name]) : "--"}
                          </span>
                        )}
                      </TableCell>
                    ))}
                    <TableCell className="w-10 px-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteRow(record.id);
                        }}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <Button type="button" variant="outline" size="sm" onClick={handleAddRow} className="gap-1">
        <Plus className="size-3.5" />
        {t("widget.addLine", "Add Line")}
      </Button>
    </div>
  );
}

// ── Inline cell editor ──────────────────────────────────

interface InlineCellProps {
  value: unknown;
  fieldType: string;
  options?: Array<{ value: string; label?: string }>;
  onChange: (value: unknown) => void;
}

function InlineCell({ value, fieldType, options, onChange }: InlineCellProps) {
  if (fieldType === "enum" && options) {
    return (
      <Select value={value != null ? String(value) : undefined} onValueChange={(v) => onChange(v)}>
        <SelectTrigger className="h-7 text-xs border-0 shadow-none bg-transparent focus:ring-1">
          <SelectValue placeholder="--" />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label ?? opt.value}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  if (fieldType === "boolean") {
    return (
      <input
        type="checkbox"
        checked={!!value}
        onChange={(e) => onChange(e.target.checked)}
        className="ml-2"
      />
    );
  }

  const inputType = getInputType(fieldType);
  return (
    <Input
      type={inputType}
      value={value != null ? String(value) : ""}
      onChange={(e) => {
        const v =
          inputType === "number"
            ? e.target.value === ""
              ? null
              : Number(e.target.value)
            : e.target.value;
        onChange(v);
      }}
      className="h-7 text-xs border-0 shadow-none bg-transparent focus:ring-1 focus:ring-ring rounded-sm"
    />
  );
}
