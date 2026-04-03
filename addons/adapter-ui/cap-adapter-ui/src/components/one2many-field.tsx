/**
 * One2ManyField — Odoo-style inline editable table for one_to_many relationships.
 *
 * Renders child records in a table with inline editing.
 * Supports: add row, delete row, inline cell editing, summary row.
 *
 * Data flow:
 * - Fetches related schema bundle to get field definitions
 * - Queries existing child records via GraphQL (parent FK filter)
 * - CRUD operations via GraphQL mutations
 */

import type { FieldDefinition, RelationDefinition, EntityDefinition } from "@linchkit/core/types";
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@linchkit/ui-kit/components";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSchemaBundle } from "../hooks/use-schema-bundle";
import { createRecord, deleteRecord, graphql, updateRecord } from "../lib/api";

// ── Types ────────────────────────────────────────────────

interface One2ManyFieldProps {
  /** Parent schema name */
  parentSchema: string;
  /** Parent record ID */
  parentId: string;
  /** Link definition describing the relationship */
  link: RelationDefinition;
  /** Whether the form is in view (read-only) mode */
  readonly?: boolean;
}

interface ChildRecord {
  id: string;
  [key: string]: unknown;
}

/** Temporary row being added (not yet persisted) */
interface PendingRow {
  _tempId: string;
  [key: string]: unknown;
}

/** Columns to display — derived from the child schema fields */
interface ColumnDef {
  field: string;
  label: string;
  type: string;
  fieldDef: FieldDefinition;
}

// ── Field filtering ──────────────────────────────────────

/** System fields and FK fields to exclude from inline table columns */
const HIDDEN_FIELDS = new Set([
  "id",
  "tenant_id",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
  "_version",
  "is_deleted",
]);

/** Field types suitable for inline editing */
const INLINE_EDITABLE_TYPES = new Set(["string", "number", "text", "boolean", "enum"]);

// ── Helpers ──────────────────────────────────────────────

/** Convert snake_case to camelCase for GraphQL query names */
function toCamelCase(name: string): string {
  const parts = name.split(/[_-]/);
  return (
    parts[0] +
    parts
      .slice(1)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join("")
  );
}

/** Derive the FK column name on the child table pointing to parent.
 *  Must match the convention in schema-to-drizzle.ts generateLinkColumns():
 *  - one_to_many: FK = `{from}_id` on the `to` (child) table
 *  - many_to_one: FK = `{to}_id` on the `from` (child) table
 */
function deriveFkField(link: RelationDefinition, parentSchema: string): string {
  if (link.cardinality === "one_to_many") {
    // Parent is `from`, child is `to`. FK on child table = `{from}_id`
    return `${link.from}_id`;
  }
  if (link.cardinality === "many_to_one") {
    // Parent is `to`, child is `from`. FK on child table = `{to}_id`
    return `${link.to}_id`;
  }
  // Fallback for one_to_one or unexpected cardinalities
  return `${parentSchema}_id`;
}

/** Build column definitions from schema fields, excluding system/FK fields */
function buildColumns(schema: EntityDefinition, fkField: string): ColumnDef[] {
  const cols: ColumnDef[] = [];
  for (const [name, def] of Object.entries(schema.fields)) {
    if (HIDDEN_FIELDS.has(name)) continue;
    if (name === fkField) continue;
    // Include derived fields as readonly display columns
    cols.push({
      field: name,
      label: def.label ?? name,
      type: def.type,
      fieldDef: def,
    });
  }
  return cols;
}

/** Check if a column has numeric values suitable for summation */
function isNumericColumn(col: ColumnDef): boolean {
  return col.type === "number";
}

/** Format currency/number values for display */
function formatNumber(value: unknown, fieldDef: FieldDefinition): string {
  if (value === null || value === undefined || value === "") return "";
  const num = Number(value);
  if (Number.isNaN(num)) return String(value);
  const ui = (fieldDef as { ui?: { format?: string } }).ui;
  if (ui?.format === "currency") {
    return num.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }
  return num.toLocaleString();
}

/** Generate a temporary ID for pending rows */
function tempId(): string {
  return `_new_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── Component ────────────────────────────────────────────

export function One2ManyField({
  parentSchema,
  parentId,
  link,
  readonly = false,
}: One2ManyFieldProps) {
  const { t } = useTranslation();
  const childSchemaName = link.cardinality === "one_to_many" ? link.to : link.from;
  const { bundle: childBundle, loading: bundleLoading } = useSchemaBundle(childSchemaName);

  const [records, setRecords] = useState<ChildRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingRows, setPendingRows] = useState<PendingRow[]>([]);
  const [editingCell, setEditingCell] = useState<{ id: string; field: string } | null>(null);
  const [editValue, setEditValue] = useState<unknown>("");
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());

  const inputRef = useRef<HTMLInputElement>(null);

  const fkField = deriveFkField(link, parentSchema);
  const childSchema = childBundle?.schema;
  const columns = childSchema ? buildColumns(childSchema, fkField) : [];

  // Editable columns: exclude derived fields
  const editableColumns = columns.filter(
    (col) => !col.fieldDef.derived && INLINE_EDITABLE_TYPES.has(col.type),
  );

  // GraphQL field list for queries
  const gqlFields = ["id", ...columns.map((c) => c.field)].join(" ");

  // ── Fetch existing child records ──────────────────────

  const fetchRecords = useCallback(async () => {
    if (!childSchema) return;
    setLoading(true);
    try {
      const queryName = `${toCamelCase(childSchemaName)}List`;
      const filter = JSON.stringify({ [fkField]: { eq: parentId } });
      const query = `
        query ($filter: String) {
          ${queryName}(filter: $filter, pageSize: 200) {
            items { ${gqlFields} }
            total
          }
        }
      `;
      const res = await graphql<Record<string, { items: ChildRecord[]; total: number }>>(query, {
        filter,
      });
      if (res.data?.[queryName]) {
        setRecords(res.data[queryName].items);
      }
    } catch (err) {
      console.error("Failed to fetch child records:", err);
    } finally {
      setLoading(false);
    }
  }, [childSchema, childSchemaName, fkField, parentId, gqlFields]);

  useEffect(() => {
    if (childSchema) {
      fetchRecords();
    }
  }, [childSchema, fetchRecords]);

  // ── Inline editing ────────────────────────────────────

  function startEdit(recordId: string, field: string, currentValue: unknown) {
    if (readonly) return;
    // Don't allow editing derived fields
    const col = columns.find((c) => c.field === field);
    if (col?.fieldDef.derived) return;
    if (!INLINE_EDITABLE_TYPES.has(col?.type ?? "")) return;

    setEditingCell({ id: recordId, field });
    setEditValue(currentValue ?? "");
    // Focus input after render
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  const commitEdit = useCallback(async () => {
    if (!editingCell) return;
    const { id, field } = editingCell;
    const col = columns.find((c) => c.field === field);

    // Convert value to proper type
    let finalValue: unknown = editValue;
    if (col?.type === "number") {
      finalValue = editValue === "" || editValue === null ? null : Number(editValue);
    }

    // Check if editing a pending row
    const pendingRow = pendingRows.find((r) => r._tempId === id);
    if (pendingRow) {
      setPendingRows((prev) =>
        prev.map((r) => (r._tempId === id ? { ...r, [field]: finalValue } : r)),
      );
      setEditingCell(null);
      return;
    }

    // Find original record
    const original = records.find((r) => r.id === id);
    if (!original || original[field] === finalValue) {
      setEditingCell(null);
      return;
    }

    // Save to server
    setSavingIds((prev) => new Set(prev).add(id));
    try {
      const updated = await updateRecord<ChildRecord>(
        childSchemaName,
        id,
        { [field]: finalValue },
        gqlFields.split(" "),
      );
      setRecords((prev) => prev.map((r) => (r.id === id ? updated : r)));
    } catch (err) {
      console.error("Failed to update record:", err);
    } finally {
      setSavingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      setEditingCell(null);
    }
  }, [editingCell, editValue, columns, pendingRows, records, childSchemaName, gqlFields]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      commitEdit();
    } else if (e.key === "Escape") {
      setEditingCell(null);
    }
  }

  // ── Add row ───────────────────────────────────────────

  function handleAddRow() {
    const newRow: PendingRow = { _tempId: tempId() };
    // Set defaults from field definitions
    for (const col of editableColumns) {
      if (col.fieldDef.default !== undefined) {
        newRow[col.field] = col.fieldDef.default;
      } else if (col.type === "number") {
        newRow[col.field] = null;
      } else {
        newRow[col.field] = "";
      }
    }
    setPendingRows((prev) => [...prev, newRow]);
    // Auto-focus the first editable field of the new row
    const firstEditable = editableColumns[0];
    if (firstEditable) {
      setTimeout(() => {
        setEditingCell({ id: newRow._tempId, field: firstEditable.field });
        setEditValue(newRow[firstEditable.field] ?? "");
      }, 0);
    }
  }

  async function savePendingRow(row: PendingRow) {
    const input: Record<string, unknown> = { [fkField]: parentId };
    for (const col of editableColumns) {
      if (row[col.field] !== undefined && row[col.field] !== "") {
        let val = row[col.field];
        if (col.type === "number" && val !== null) {
          val = Number(val);
        }
        input[col.field] = val;
      }
    }

    // Validate required fields
    const missingRequired = editableColumns.filter(
      (col) =>
        col.fieldDef.required &&
        (input[col.field] === undefined || input[col.field] === "" || input[col.field] === null),
    );
    if (missingRequired.length > 0) {
      // Don't save yet — let the user fill required fields
      return;
    }

    setSavingIds((prev) => new Set(prev).add(row._tempId));
    try {
      const created = await createRecord<ChildRecord>(childSchemaName, input, gqlFields.split(" "));
      // Remove pending row, add to saved records
      setPendingRows((prev) => prev.filter((r) => r._tempId !== row._tempId));
      setRecords((prev) => [...prev, created]);
    } catch (err) {
      console.error("Failed to create record:", err);
    } finally {
      setSavingIds((prev) => {
        const next = new Set(prev);
        next.delete(row._tempId);
        return next;
      });
    }
  }

  // ── Delete row ────────────────────────────────────────

  async function handleDeleteRow(id: string) {
    // Check if it's a pending row
    const pendingRow = pendingRows.find((r) => r._tempId === id);
    if (pendingRow) {
      setPendingRows((prev) => prev.filter((r) => r._tempId !== id));
      return;
    }

    setDeletingIds((prev) => new Set(prev).add(id));
    try {
      await deleteRecord(childSchemaName, id);
      setRecords((prev) => prev.filter((r) => r.id !== id));
    } catch (err) {
      console.error("Failed to delete record:", err);
    } finally {
      setDeletingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  // ── When user clicks outside or tabs away from a pending row, try to save it ──

  function handlePendingRowBlur(row: PendingRow) {
    // Check if all required fields are filled before auto-saving
    const hasAllRequired = editableColumns
      .filter((col) => col.fieldDef.required)
      .every((col) => {
        const val = row[col.field];
        return val !== undefined && val !== "" && val !== null;
      });

    if (hasAllRequired) {
      savePendingRow(row);
    }
  }

  // ── Summary row ───────────────────────────────────────

  const numericColumns = columns.filter(isNumericColumn);
  const hasSummary = numericColumns.length > 0 && records.length > 0;

  function computeSum(field: string): number {
    return records.reduce((sum, r) => {
      const val = Number(r[field]);
      return sum + (Number.isNaN(val) ? 0 : val);
    }, 0);
  }

  // ── Render ────────────────────────────────────────────

  if (bundleLoading) {
    return (
      <div className="space-y-2 py-2">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }

  if (!childSchema || columns.length === 0) {
    return null;
  }

  const label =
    (link.cardinality === "one_to_many" ? link.label?.from : link.label?.to) ??
    childSchema.label ??
    childSchemaName;

  // All rows to render (saved + pending)
  const allRows: Array<{ id: string; data: Record<string, unknown>; isPending: boolean }> = [
    ...records.map((r) => ({ id: r.id, data: r as Record<string, unknown>, isPending: false })),
    ...pendingRows.map((r) => ({
      id: r._tempId,
      data: r as Record<string, unknown>,
      isPending: true,
    })),
  ];

  return (
    <div className="mt-2">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium text-muted-foreground">{label}</h3>
        {loading && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
      </div>

      <div className="border rounded-md">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50">
              <TableHead className="w-10 text-center text-xs">#</TableHead>
              {columns.map((col) => (
                <TableHead key={col.field} className="text-xs">
                  {col.label}
                </TableHead>
              ))}
              {!readonly && <TableHead className="w-10" />}
            </TableRow>
          </TableHeader>

          <TableBody>
            {allRows.length === 0 && !loading && (
              <TableRow>
                <TableCell
                  colSpan={columns.length + (readonly ? 1 : 2)}
                  className="text-center text-sm text-muted-foreground py-6"
                >
                  {t("list.noRecords", "No records found")}
                </TableCell>
              </TableRow>
            )}

            {allRows.map((row, idx) => {
              const isSaving = savingIds.has(row.id);
              const isDeleting = deletingIds.has(row.id);

              return (
                <TableRow key={row.id} className={row.isPending ? "bg-primary/5" : undefined}>
                  {/* Row number */}
                  <TableCell className="text-center text-xs text-muted-foreground">
                    {idx + 1}
                  </TableCell>

                  {/* Field cells */}
                  {columns.map((col) => {
                    const cellValue = row.data[col.field];
                    const isEditing =
                      editingCell?.id === row.id && editingCell?.field === col.field;
                    const isDerived = !!col.fieldDef.derived;
                    const isEditableType = INLINE_EDITABLE_TYPES.has(col.type);
                    const canEdit = !readonly && !isDerived && isEditableType;

                    return (
                      <TableCell
                        key={col.field}
                        className={canEdit ? "cursor-pointer hover:bg-muted/30 p-0" : ""}
                        onClick={() => {
                          if (canEdit && !isEditing) {
                            startEdit(row.id, col.field, cellValue);
                          }
                        }}
                      >
                        {isEditing ? (
                          <InlineCellEditor
                            ref={inputRef}
                            col={col}
                            value={editValue}
                            onChange={setEditValue}
                            onBlur={() => {
                              // commitEdit is the single source of truth for
                              // persisting the edit value into pendingRows state.
                              // After it completes, check if the pending row is
                              // ready for auto-save.
                              commitEdit()
                                .then(() => {
                                  if (row.isPending) {
                                    // Re-read the latest pending row from state via
                                    // setState callback to avoid stale closure
                                    setPendingRows((prev) => {
                                      const updatedRow = prev.find((r) => r._tempId === row.id);
                                      if (updatedRow) {
                                        handlePendingRowBlur(updatedRow);
                                      }
                                      return prev;
                                    });
                                  }
                                })
                                .catch(console.error);
                            }}
                            onKeyDown={handleKeyDown}
                          />
                        ) : (
                          <CellDisplay col={col} value={cellValue} />
                        )}
                      </TableCell>
                    );
                  })}

                  {/* Delete button */}
                  {!readonly && (
                    <TableCell className="text-center p-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7 text-muted-foreground hover:text-destructive"
                        disabled={isSaving || isDeleting}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteRow(row.id);
                        }}
                      >
                        {isDeleting ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="size-3.5" />
                        )}
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>

          {/* Summary footer row */}
          {hasSummary && (
            <TableFooter>
              <TableRow>
                <TableCell />
                {columns.map((col) => (
                  <TableCell key={col.field} className="text-xs font-medium">
                    {isNumericColumn(col) ? formatNumber(computeSum(col.field), col.fieldDef) : ""}
                  </TableCell>
                ))}
                {!readonly && <TableCell />}
              </TableRow>
            </TableFooter>
          )}
        </Table>

        {/* Add a line */}
        {!readonly && (
          <div className="border-t px-3 py-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-primary hover:text-primary/80 text-xs h-7 px-2"
              onClick={handleAddRow}
            >
              <Plus className="size-3.5 mr-1" />
              {t("one2many.addLine", "Add a line")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────

/** Inline cell editor — renders appropriate input based on field type */
import { forwardRef } from "react";

interface InlineCellEditorProps {
  col: ColumnDef;
  value: unknown;
  onChange: (value: unknown) => void;
  onBlur: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}

const InlineCellEditor = forwardRef<HTMLInputElement, InlineCellEditorProps>(
  function InlineCellEditor({ col, value, onChange, onBlur, onKeyDown }, ref) {
    // Enum field — use select dropdown
    if (col.type === "enum" && "options" in col.fieldDef) {
      const options =
        (col.fieldDef as { options?: Array<{ value: string; label?: string }> }).options ?? [];
      return (
        <div className="px-2 py-1">
          <Select
            value={String(value ?? "")}
            onValueChange={(v) => {
              onChange(v);
              // Auto-commit for selects
              setTimeout(onBlur, 0);
            }}
          >
            <SelectTrigger className="h-7 text-xs border-primary/50">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label ?? opt.value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      );
    }

    // Number field
    if (col.type === "number") {
      return (
        <Input
          ref={ref}
          type="number"
          className="h-8 text-sm border-primary/50 rounded-none focus-visible:ring-1 focus-visible:ring-primary"
          value={value === null || value === undefined ? "" : String(value)}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          onKeyDown={onKeyDown}
          step="any"
        />
      );
    }

    // Default: text input
    return (
      <Input
        ref={ref}
        type="text"
        className="h-8 text-sm border-primary/50 rounded-none focus-visible:ring-1 focus-visible:ring-primary"
        value={String(value ?? "")}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
      />
    );
  },
);

/** Cell display — renders formatted value */
function CellDisplay({ col, value }: { col: ColumnDef; value: unknown }) {
  if (value === null || value === undefined || value === "") {
    return <span className="text-muted-foreground px-2">-</span>;
  }

  if (col.type === "number") {
    return <span className="px-2">{formatNumber(value, col.fieldDef)}</span>;
  }

  if (col.type === "enum" && "options" in col.fieldDef) {
    const options =
      (col.fieldDef as { options?: Array<{ value: string; label?: string }> }).options ?? [];
    const match = options.find((o) => o.value === value);
    return <span className="px-2">{match?.label ?? String(value)}</span>;
  }

  if (col.type === "boolean") {
    return <BooleanCellDisplay value={value} />;
  }

  return <span className="px-2">{String(value)}</span>;
}

/** i18n-aware boolean cell display */
function BooleanCellDisplay({ value }: { value: unknown }) {
  const { t } = useTranslation();
  return <span className="px-2">{value ? t("common.yes", "Yes") : t("common.no", "No")}</span>;
}
