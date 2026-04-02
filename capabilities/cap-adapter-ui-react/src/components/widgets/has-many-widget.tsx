/**
 * HasMany widget — List table with dialog editing for one_to_many relationship fields.
 *
 * Display: Shows count badge in list view, or first few related record labels as chips.
 * Input: Read-only table showing child records. Click a row to edit in a Dialog.
 *        Click "Add Line" to create a new child in a Dialog. All changes are held
 *        in client memory until the parent form is saved (Odoo-style).
 */

import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
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
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSchemaBundle } from "@/hooks/use-schema-bundle";
import type { WidgetDisplayProps, WidgetInputProps } from "@/lib/widget-registry";
import { getRecordLabel, type RelatedRecord } from "./relation-utils";

/** Generate a virtual temporary ID */
function generateTempId(): string {
  return `_virtual_${crypto.randomUUID()}`;
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

/** Editable field descriptor resolved from target schema */
interface EditableField {
  name: string;
  label: string;
  type: string;
  required: boolean;
  options?: Array<{ value: string; label?: string }>;
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
  const editableFields = useMemo((): EditableField[] => {
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

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRecord, setEditingRecord] = useState<RelatedRecord | null>(null);
  const [dialogFormData, setDialogFormData] = useState<Record<string, unknown>>({});

  /** Build default values for a new record */
  const buildDefaults = useCallback((): Record<string, unknown> => {
    const defaults: Record<string, unknown> = {};
    for (const field of editableFields) {
      if (field.type === "number") {
        defaults[field.name] = field.required ? 0 : null;
      } else if (field.type === "boolean") {
        defaults[field.name] = false;
      } else {
        defaults[field.name] = "";
      }
    }
    return defaults;
  }, [editableFields]);

  const handleAddRow = useCallback(() => {
    setEditingRecord(null);
    setDialogFormData(buildDefaults());
    setDialogOpen(true);
  }, [buildDefaults]);

  const handleEditRow = useCallback((record: RelatedRecord) => {
    setEditingRecord(record);
    // Clone record data into dialog form
    const data: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
      if (key === "id" || key === "_virtual") continue;
      data[key] = record[key];
    }
    setDialogFormData(data);
    setDialogOpen(true);
  }, []);

  const handleDeleteRow = useCallback(
    (recordId: string) => {
      const updated = records.filter((r) => r.id !== recordId);
      onChange(updated);
    },
    [records, onChange],
  );

  const handleDialogSave = useCallback(() => {
    if (editingRecord) {
      // Update existing record
      const updated = records.map((r) => {
        if (r.id !== editingRecord.id) return r;
        return { ...r, ...dialogFormData };
      });
      onChange(updated);
    } else {
      // Create new record
      const newRecord: RelatedRecord = {
        id: generateTempId(),
        _virtual: true,
        ...dialogFormData,
      };
      onChange([...records, newRecord]);
    }
    setDialogOpen(false);
    setEditingRecord(null);
    setDialogFormData({});
  }, [editingRecord, records, dialogFormData, onChange]);

  const handleDialogFieldChange = useCallback((fieldName: string, fieldValue: unknown) => {
    setDialogFormData((prev) => ({ ...prev, [fieldName]: fieldValue }));
  }, []);

  /** Format a cell value for display in the table */
  function formatCellValue(record: RelatedRecord, field: EditableField): string {
    const val = record[field.name];
    if (val == null || val === "") return "--";
    if (field.type === "enum" && field.options) {
      const opt = field.options.find((o) => o.value === String(val));
      return opt?.label ?? String(val);
    }
    return String(val);
  }

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
                        {formatCellValue(record, field)}
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

  // Editable mode: read-only table + click row to edit in dialog
  return (
    <div className="space-y-2">
      {editableFields.length > 0 && (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                {editableFields.map((field) => (
                  <TableHead key={field.name} className="text-xs">
                    {field.label}
                    {field.required && <span className="text-destructive ml-0.5">*</span>}
                  </TableHead>
                ))}
                <TableHead className="w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {records.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={editableFields.length + 1}
                    className="text-center text-sm text-muted-foreground py-6"
                  >
                    {t("widget.hasManyEmpty", 'No items yet. Click "Add Line" to add one.')}
                  </TableCell>
                </TableRow>
              )}
              {records.map((record) => (
                <TableRow
                  key={record.id}
                  className="group cursor-pointer hover:bg-muted/50"
                  onClick={() => handleEditRow(record)}
                >
                  {editableFields.map((field) => (
                    <TableCell key={field.name} className="text-sm">
                      {formatCellValue(record, field)}
                    </TableCell>
                  ))}
                  <TableCell className="w-20 px-1">
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7 text-muted-foreground hover:text-primary"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleEditRow(record);
                        }}
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7 text-muted-foreground hover:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteRow(record.id);
                        }}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Button type="button" variant="outline" size="sm" onClick={handleAddRow} className="gap-1">
        <Plus className="size-3.5" />
        {t("widget.addLine", "Add Line")}
      </Button>

      {/* Edit / Create Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editingRecord
                ? t("widget.editItem", "Edit Item")
                : t("widget.addItem", "Add Item")}
            </DialogTitle>
            <DialogDescription>
              {editingRecord
                ? t("widget.editItemDesc", "Modify the fields below and save.")
                : t("widget.addItemDesc", "Fill in the fields below to add a new item.")}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-2">
            {editableFields.map((field) => (
              <DialogFieldInput
                key={field.name}
                field={field}
                value={dialogFormData[field.name]}
                onChange={(v) => handleDialogFieldChange(field.name, v)}
              />
            ))}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="button" onClick={handleDialogSave}>
              {t("common.confirm", "Confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Dialog field input ──────────────────────────────────

interface DialogFieldInputProps {
  field: EditableField;
  value: unknown;
  onChange: (value: unknown) => void;
}

function DialogFieldInput({ field, value, onChange }: DialogFieldInputProps) {
  if (field.type === "enum" && field.options) {
    return (
      <div className="grid gap-2">
        <Label>
          {field.label}
          {field.required && <span className="text-destructive ml-0.5">*</span>}
        </Label>
        <Select
          value={value != null ? String(value) : undefined}
          onValueChange={(v) => onChange(v)}
        >
          <SelectTrigger>
            <SelectValue placeholder="--" />
          </SelectTrigger>
          <SelectContent>
            {field.options.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label ?? opt.value}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }

  if (field.type === "boolean") {
    return (
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id={`dialog-field-${field.name}`}
          checked={!!value}
          onChange={(e) => onChange(e.target.checked)}
        />
        <Label htmlFor={`dialog-field-${field.name}`}>
          {field.label}
          {field.required && <span className="text-destructive ml-0.5">*</span>}
        </Label>
      </div>
    );
  }

  const inputType = getInputType(field.type);
  return (
    <div className="grid gap-2">
      <Label>
        {field.label}
        {field.required && <span className="text-destructive ml-0.5">*</span>}
      </Label>
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
      />
    </div>
  );
}
