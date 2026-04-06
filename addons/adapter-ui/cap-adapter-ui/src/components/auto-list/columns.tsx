/**
 * Generate TanStack Table ColumnDef[] from schema + view definition.
 */

import type {
  EntityDefinition,
  EnumField,
  FieldDefinition,
  StateMeta,
  ViewAction,
  ViewFieldConfig,
} from "@linchkit/core/types";
import {
  Button,
  Checkbox,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@linchkit/ui-kit/components";
import type { ColumnDef } from "@tanstack/react-table";
import i18next from "i18next";
import { ArrowDown, ArrowUp, ArrowUpDown, MoreHorizontal, Puzzle } from "lucide-react";
import type React from "react";
import { type EditingCell, isFieldTypeEditable } from "../../hooks/use-inline-edit";
import type { FieldOverlayRecord, OverlayFieldType } from "../../lib/overlay-types";
import { FieldDisplay } from "../field-renderer";
import { InlineEditCell } from "./inline-edit-cell";
import { StatusBadge } from "./status-badge";

type DataRow = Record<string, unknown>;

export interface BuildColumnsOptions {
  fields: ViewFieldConfig[];
  schema: EntityDefinition;
  rowActions: ViewAction[];
  onAction?: (actionName: string, recordId: string) => void;
  stateMeta?: Partial<Record<string, StateMeta>>;
  /** Resolve labels that may use the `t:` i18n prefix convention. */
  resolveLabel?: (label: string | undefined, fallback: string) => string;
  /** Currently editing cell (for inline edit support) */
  editingCell?: EditingCell | null;
  /** Start editing a cell */
  onStartEditing?: (rowId: string, field: string) => void;
  /** Save inline edit */
  onSaveEdit?: (rowId: string, field: string, value: unknown) => void;
  /** Cancel inline edit */
  onCancelEdit?: () => void;
  /** Runtime overlay fields to append as additional columns */
  overlayFields?: FieldOverlayRecord[];
}

export function buildColumns(opts: BuildColumnsOptions): ColumnDef<DataRow>[] {
  const {
    fields,
    schema,
    rowActions,
    onAction,
    stateMeta,
    resolveLabel,
    editingCell,
    onStartEditing,
    onSaveEdit,
    onCancelEdit,
    overlayFields,
  } = opts;
  const resolve = resolveLabel ?? ((l: string | undefined, fb: string) => l ?? fb);
  const cols: ColumnDef<DataRow>[] = fields.map((vf) => {
    const fieldDef = schema.fields[vf.field];
    const rawLabel = vf.label ?? fieldDef?.label ?? vf.field;
    const label = resolve(rawLabel, vf.field);

    // Determine if this field supports inline editing
    const canInlineEdit =
      vf.editable === true &&
      !vf.readonly &&
      fieldDef &&
      isFieldTypeEditable(fieldDef.type) &&
      onStartEditing &&
      onSaveEdit &&
      onCancelEdit;

    return {
      accessorKey: vf.field,
      header: ({ column }) => {
        if (!vf.sortable) {
          return <span className="text-xs font-medium">{label}</span>;
        }
        const sorted = column.getIsSorted();
        return (
          <button
            type="button"
            className="flex items-center gap-1 text-xs font-medium hover:text-foreground"
            onClick={() => column.toggleSorting(sorted === "asc")}
          >
            {label}
            {sorted === "asc" ? (
              <ArrowUp className="size-3.5" />
            ) : sorted === "desc" ? (
              <ArrowDown className="size-3.5" />
            ) : (
              <ArrowUpDown className="size-3.5 opacity-30" />
            )}
          </button>
        );
      },
      cell: ({ getValue, row }) => {
        const value = getValue();
        const rowId = String(row.original.id ?? "");

        // Inline editable cell
        if (canInlineEdit && rowId) {
          const isEditing = editingCell?.rowId === rowId && editingCell?.field === vf.field;
          return (
            <InlineEditCell
              field={vf}
              fieldDef={fieldDef}
              value={value}
              rowId={rowId}
              isEditing={isEditing}
              stateMeta={stateMeta}
              onDoubleClick={() => onStartEditing(rowId, vf.field)}
              onSave={(newValue) => onSaveEdit(rowId, vf.field, newValue)}
              onCancel={onCancelEdit}
            />
          );
        }

        // Standard display
        if (fieldDef?.type === "state" && typeof value === "string") {
          return <StatusBadge value={value} meta={stateMeta} />;
        }
        if (fieldDef) {
          return <FieldDisplay field={vf} value={value} fieldDef={fieldDef} />;
        }
        return String(value ?? "");
      },
      enableSorting: vf.sortable ?? false,
      size: typeof vf.width === "number" ? vf.width : undefined,
    };
  });

  // Overlay field columns (read from row._extensions)
  if (overlayFields && overlayFields.length > 0) {
    for (const overlay of overlayFields) {
      const overlayLabel = resolveOverlayColumnLabel(overlay);
      const sortable =
        overlay.fieldType === "string" ||
        overlay.fieldType === "number" ||
        overlay.fieldType === "date";
      cols.push({
        id: `_ovl_${overlay.fieldName}`,
        accessorFn: (row) => {
          const ext = row._extensions as Record<string, unknown> | undefined;
          return ext?.[overlay.fieldName] ?? null;
        },
        header: ({ column }) => {
          if (!sortable) {
            return (
              <span className="flex items-center gap-1 text-xs font-medium">
                {overlayLabel}
                <Puzzle className="size-3 text-muted-foreground/50" />
              </span>
            );
          }
          const sorted = column.getIsSorted();
          return (
            <button
              type="button"
              className="flex items-center gap-1 text-xs font-medium hover:text-foreground"
              onClick={() => column.toggleSorting(sorted === "asc")}
            >
              {overlayLabel}
              <Puzzle className="size-3 text-muted-foreground/50" />
              {sorted === "asc" ? (
                <ArrowUp className="size-3.5" />
              ) : sorted === "desc" ? (
                <ArrowDown className="size-3.5" />
              ) : (
                <ArrowUpDown className="size-3.5 opacity-30" />
              )}
            </button>
          );
        },
        cell: ({ getValue }) => {
          const value = getValue();
          return formatOverlayCellValue(value, overlay.fieldType);
        },
        enableSorting: sortable,
        size: 150,
      });
    }
  }

  // Row actions column
  if (rowActions.length > 0) {
    cols.push({
      id: "_actions",
      header: () => null,
      cell: ({ row }) => {
        const recordId = String(row.original.id ?? "");
        const destructive = rowActions.filter((a) => a.variant === "destructive");
        const normal = rowActions.filter((a) => a.variant !== "destructive");
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon">
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {normal.map((a) => (
                <DropdownMenuItem
                  key={a.action}
                  onClick={(e) => {
                    e.stopPropagation();
                    onAction?.(a.action, recordId);
                  }}
                >
                  {resolve(a.label, a.action)}
                </DropdownMenuItem>
              ))}
              {destructive.length > 0 && normal.length > 0 && <DropdownMenuSeparator />}
              {destructive.map((a) => (
                <DropdownMenuItem
                  key={a.action}
                  className="text-destructive"
                  onClick={(e) => {
                    e.stopPropagation();
                    onAction?.(a.action, recordId);
                  }}
                >
                  {resolve(a.label, a.action)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
      size: 50,
      enableSorting: false,
    });
  }

  return cols;
}

/** Build a checkbox column for row selection. */
export function buildSelectionColumn(): ColumnDef<DataRow> {
  return {
    id: "_select",
    header: ({ table }) => (
      <Checkbox
        checked={
          table.getIsAllPageRowsSelected()
            ? true
            : table.getIsSomePageRowsSelected()
              ? "indeterminate"
              : false
        }
        onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
        aria-label={i18next.t("list.selectAll", "Select all")}
        onClick={(e) => e.stopPropagation()}
      />
    ),
    cell: ({ row }) => (
      <Checkbox
        checked={row.getIsSelected()}
        onCheckedChange={(value) => row.toggleSelected(!!value)}
        aria-label={i18next.t("list.selectRow", "Select row")}
        onClick={(e) => e.stopPropagation()}
      />
    ),
    size: 40,
    enableSorting: false,
    enableHiding: false,
  };
}

/**
 * Resolve the best label for an overlay field in list column header.
 */
function resolveOverlayColumnLabel(overlay: FieldOverlayRecord): string {
  if (!overlay.config.label) return overlay.fieldName;
  const lang = typeof navigator !== "undefined" ? navigator.language : "en";
  return (
    overlay.config.label[lang] ??
    overlay.config.label.en ??
    Object.values(overlay.config.label)[0] ??
    overlay.fieldName
  );
}

/**
 * Format an overlay cell value for display based on field type.
 */
function formatOverlayCellValue(value: unknown, fieldType: OverlayFieldType): React.ReactNode {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground">&mdash;</span>;
  }
  switch (fieldType) {
    case "boolean":
      return value ? "\u2713" : "\u2717";
    case "date":
      try {
        return new Date(String(value)).toLocaleDateString();
      } catch {
        return String(value);
      }
    case "json":
      return (
        <span className="font-mono text-xs truncate max-w-[200px] inline-block">
          {typeof value === "string" ? value : JSON.stringify(value)}
        </span>
      );
    default:
      return String(value);
  }
}

export function getEnumOptions(fieldDef?: FieldDefinition): { value: string; label: string }[] {
  if (!fieldDef) return [];
  if (fieldDef.type === "enum" && (fieldDef as EnumField).options) {
    return (fieldDef as EnumField).options.map((o) => ({
      value: o.value,
      label: o.label ?? o.value,
    }));
  }
  return [];
}
