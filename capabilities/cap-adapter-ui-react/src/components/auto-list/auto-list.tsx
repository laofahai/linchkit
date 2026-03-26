/**
 * AutoList — Unified list view powered by TanStack Table.
 *
 * Single component that handles both schema-driven and manual-column modes:
 * - Schema-driven: pass `schema` + `view` to auto-build columns, filters, AI search, inline edit.
 * - Manual columns: pass `columns` (raw ColumnDef[]) for admin/non-schema pages.
 * - Hybrid: pass `schema` + `view` + `columns` for schema features with custom columns.
 *
 * All modes share identical table rendering, sorting, global filtering, pagination, and toolbar.
 */

import { Skeleton } from "@linchkit/ui-kit/components";
import { cn } from "@linchkit/ui-kit/lib/utils";
import {
  type ColumnDef,
  type ColumnFiltersState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  type RowSelectionState,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown, Inbox } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAISearch, isNaturalLanguageQuery } from "../../hooks/use-ai-search";
import { useInlineEdit } from "../../hooks/use-inline-edit";
import { useSchemaLabel } from "../../i18n/use-schema-label";
import { useDataTableFilters } from "../data-table-filter";
import type { FiltersState } from "../data-table-filter/core/types";
import { buildColumns, buildSelectionColumn } from "./columns";
import { exportCsv } from "./csv-export";
import { buildFilterColumns } from "./filter-columns";
import { BulkEditDialog } from "./bulk-edit-dialog";
import { ImportDialog } from "./import-dialog";
import { ListPagination } from "./list-pagination";
import { ListToolbar } from "./list-toolbar";
import { EmptyState } from "../empty-state";
import type { AutoListProps } from "./types";

/** Stable keys for skeleton placeholder rows (avoids array-index-as-key). */
const SKELETON_KEYS = ["skel-1", "skel-2", "skel-3", "skel-4", "skel-5"] as const;

/**
 * Coerce a value to a number. If Number() returns NaN, try Date.parse() as fallback.
 * Returns null if the value cannot be coerced to a meaningful number.
 */
function coerceNumericOrDate(val: unknown): number | null {
  const n = Number(val);
  if (!Number.isNaN(n)) return n;
  // Fallback: try parsing as date
  if (typeof val === "string") {
    const d = Date.parse(val);
    if (!Number.isNaN(d)) return d;
  }
  return null;
}

/**
 * Apply a DeclarativeCondition filter to a single row (client-side evaluation).
 * Supports simple conditions, composite (and/or), and not.
 */
function evaluateCondition(
  row: Record<string, unknown>,
  condition: Record<string, unknown>,
): boolean {
  const operator = condition.operator as string;

  // Composite: and / or
  if (operator === "and" || operator === "or") {
    const conditions = condition.conditions as Record<string, unknown>[];
    if (!Array.isArray(conditions)) return true;
    if (operator === "and") return conditions.every((c) => evaluateCondition(row, c));
    return conditions.some((c) => evaluateCondition(row, c));
  }

  // Not
  if (operator === "not") {
    const inner = condition.condition as Record<string, unknown>;
    if (!inner) return true;
    return !evaluateCondition(row, inner);
  }

  // Simple condition
  const field = condition.field as string;
  const value = condition.value;
  if (!field) return true;

  const rowVal = row[field];

  switch (operator) {
    case "eq":
      return rowVal === value || String(rowVal) === String(value);
    case "neq":
      return rowVal !== value && String(rowVal) !== String(value);
    case "gt": {
      const a = coerceNumericOrDate(rowVal), b = coerceNumericOrDate(value);
      if (a === null || b === null) return false;
      return a > b;
    }
    case "gte": {
      const a = coerceNumericOrDate(rowVal), b = coerceNumericOrDate(value);
      if (a === null || b === null) return false;
      return a >= b;
    }
    case "lt": {
      const a = coerceNumericOrDate(rowVal), b = coerceNumericOrDate(value);
      if (a === null || b === null) return false;
      return a < b;
    }
    case "lte": {
      const a = coerceNumericOrDate(rowVal), b = coerceNumericOrDate(value);
      if (a === null || b === null) return false;
      return a <= b;
    }
    case "contains":
      return String(rowVal ?? "").toLowerCase().includes(String(value ?? "").toLowerCase());
    case "startsWith":
      return String(rowVal ?? "").toLowerCase().startsWith(String(value ?? "").toLowerCase());
    case "endsWith":
      return String(rowVal ?? "").toLowerCase().endsWith(String(value ?? "").toLowerCase());
    case "in": {
      const arr = Array.isArray(value) ? value : [value];
      return arr.some((v) => String(rowVal) === String(v));
    }
    case "not_in": {
      const arr = Array.isArray(value) ? value : [value];
      return !arr.some((v) => String(rowVal) === String(v));
    }
    case "between": {
      const arr = Array.isArray(value) ? value : [];
      if (arr.length < 2) return true;
      const n = coerceNumericOrDate(rowVal);
      const lo = coerceNumericOrDate(arr[0]);
      const hi = coerceNumericOrDate(arr[1]);
      if (n === null || lo === null || hi === null) return false;
      return n >= lo && n <= hi;
    }
    case "is_null":
      return rowVal === null || rowVal === undefined;
    case "not_null":
      return rowVal !== null && rowVal !== undefined;
    default:
      return true;
  }
}

// ── Shared table rendering ──────────────────────────────────────────────────

interface TableShellProps {
  table: ReturnType<typeof useReactTable<Record<string, unknown>>>;
  columns: ColumnDef<Record<string, unknown>, unknown>[];
  onRowClick?: (recordId: string) => void;
  hasActiveFilters: boolean;
}

/** Shared table + pagination rendering. */
function TableShell({ table, columns, onRowClick, hasActiveFilters }: TableShellProps) {
  const { t } = useTranslation();
  return (
    <>
      {/* Table */}
      <div className="rounded border border-border overflow-x-auto">
        <table className="w-full text-sm min-w-[600px]">
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id} className="border-b border-border bg-muted/50">
                {headerGroup.headers.map((header) => (
                  <th
                    key={header.id}
                    className="px-3 py-2 text-left font-medium text-muted-foreground"
                    style={header.getSize() !== 150 ? { width: header.getSize() } : undefined}
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="py-12 text-center text-muted-foreground">
                  <Inbox className="mx-auto mb-2 size-8 opacity-40" />
                  <p className="text-sm">{t("list.noRecords")}</p>
                  {hasActiveFilters && <p className="mt-1 text-xs">{t("list.filterHint")}</p>}
                </td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row) => (
                <tr
                  key={row.id}
                  className={cn(
                    "border-b border-border last:border-0 transition-colors",
                    onRowClick && "cursor-pointer hover:bg-muted/50",
                    row.getIsSelected() && "bg-muted",
                  )}
                  onClick={() => {
                    const id = String(row.original.id ?? row.original.name ?? row.id);
                    if (onRowClick) onRowClick(id);
                  }}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-3 py-1.5">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <ListPagination table={table} />
    </>
  );
}

// ── Unified AutoList ────────────────────────────────────────────────────────

export function AutoList({
  data,
  loading = false,
  title: _title,
  onRowClick,
  toolbarExtra,
  onRefresh,
  refreshing = false,
  emptyState,
  // Schema-driven props
  schema,
  view,
  stateMeta,
  onAction,
  onBulkAction,
  selectable = false,
  onInlineEditSaved,
  onInlineEditError,
  onFiltersChange,
  // Column override / simple mode props
  columns: columnsProp,
  pageSize: pageSizeProp,
  defaultSorting,
}: AutoListProps) {
  const { t } = useTranslation();
  const { resolveLabel } = useSchemaLabel();

  // Whether schema-driven features are active
  const isSchemaMode = !!(schema && view);

  // ── Sorting ─────────────────────────────────────────────────────────────

  const [sorting, setSorting] = useState<SortingState>(() => {
    if (view?.defaultSort) {
      return [{ id: view.defaultSort.field, desc: view.defaultSort.order === "desc" }];
    }
    return defaultSorting ?? [];
  });
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [importOpen, setImportOpen] = useState(false);
  const [bulkEditOpen, setBulkEditOpen] = useState(false);

  // ── AI search (schema mode only) ────────────────────────────────────────

  const {
    aiSearch: aiSearchState,
    triggerAISearch,
    clearAISearch,
  } = useAISearch(schema ?? null);

  const handleSearchSubmit = useCallback(
    (query: string) => {
      if (isSchemaMode && isNaturalLanguageQuery(query)) {
        triggerAISearch(query);
      }
    },
    [isSchemaMode, triggerAISearch],
  );

  const handleGlobalFilterChange = useCallback(
    (value: string) => {
      setGlobalFilter(value);
    },
    [],
  );

  // ── Bazza filters (schema mode only) ──────────────────────────────────

  const filterColumnsConfig = useMemo(
    () => (isSchemaMode ? buildFilterColumns(schema, data, stateMeta, resolveLabel) : []),
    [isSchemaMode, schema, data, stateMeta, resolveLabel],
  );

  const [bazzaFilters, setBazzaFilters] = useState<FiltersState>([]);
  const {
    columns: bazzaColumns,
    filters: bazzaFilterState,
    actions: bazzaActions,
    strategy: bazzaStrategy,
  } = useDataTableFilters({
    strategy: "client",
    data,
    columnsConfig: filterColumnsConfig,
    filters: bazzaFilters,
    onFiltersChange: setBazzaFilters,
  });

  // Clear selection when filters change
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset
  useEffect(() => {
    setRowSelection({});
  }, [columnFilters, globalFilter, bazzaFilterState, aiSearchState.result]);

  // Notify parent of filter changes (used by saved views)
  useEffect(() => {
    onFiltersChange?.(
      bazzaFilterState.map((f) => ({
        field: f.field,
        operator: f.operator,
        values: [...f.values],
      })),
    );
  }, [bazzaFilterState, onFiltersChange]);

  // ── Actions (schema mode only) ────────────────────────────────────────

  const toolbarActions = useMemo(
    () => (view?.actions ?? []).filter((a) => a.position === "toolbar"),
    [view?.actions],
  );
  const rowActions = useMemo(
    () => (view?.actions ?? []).filter((a) => a.position === "row"),
    [view?.actions],
  );

  // ── Inline edit (schema mode only) ────────────────────────────────────

  const hasEditableFields = useMemo(
    () => view?.fields.some((f) => f.editable) ?? false,
    [view?.fields],
  );

  const queryFields = useMemo(
    () => (view ? ["id", ...view.fields.map((f) => f.field)] : []),
    [view],
  );

  const {
    editingCell,
    startEditing,
    cancelEditing,
    saveEdit,
  } = useInlineEdit({
    schemaName: schema?.name ?? "",
    queryFields,
    onSaved: onInlineEditSaved,
    onError: onInlineEditError,
  });

  // ── Pre-filter data (bazza + AI) ──────────────────────────────────────

  const filteredData = useMemo(() => {
    let result = data;

    // Apply bazza filters (schema mode only)
    if (bazzaFilterState.length > 0) {
      result = result.filter((row) =>
        bazzaFilterState.every((f) => {
          const val = row[f.field];
          const fv = f.values;
          if (fv.length === 0) return true;
          switch (f.operator) {
            case "eq":
            case "in":
              return fv.includes(val as string);
            case "neq":
            case "not_in":
              return !fv.includes(val as string);
            case "contains":
              return String(val ?? "")
                .toLowerCase()
                .includes(String(fv[0] ?? "").toLowerCase());
            case "gt":
              return Number(val) > Number(fv[0]);
            case "gte":
              return Number(val) >= Number(fv[0]);
            case "lt":
              return Number(val) < Number(fv[0]);
            case "lte":
              return Number(val) <= Number(fv[0]);
            case "between":
              return Number(val) >= Number(fv[0]) && Number(val) <= Number(fv[1]);
            default:
              return true;
          }
        }),
      );
    }

    // Apply AI filter
    if (aiSearchState.result?.filter) {
      const aiFilter = aiSearchState.result.filter as Record<string, unknown>;
      result = result.filter((row) => evaluateCondition(row, aiFilter));
    }

    return result;
  }, [data, bazzaFilterState, aiSearchState.result]);

  // ── Columns ───────────────────────────────────────────────────────────

  const columns = useMemo(() => {
    // If caller provided explicit columns, use those
    if (columnsProp) {
      const cols = [...columnsProp];
      if (selectable && isSchemaMode) cols.unshift(buildSelectionColumn());
      return cols;
    }
    // Otherwise, build from schema + view (schema mode required)
    if (!isSchemaMode) return [];
    const cols = buildColumns({
      fields: view.fields,
      schema: schema,
      rowActions,
      onAction,
      stateMeta,
      resolveLabel,
      ...(hasEditableFields
        ? {
            editingCell,
            onStartEditing: startEditing,
            onSaveEdit: saveEdit,
            onCancelEdit: cancelEditing,
          }
        : {}),
    });
    if (selectable) cols.unshift(buildSelectionColumn());
    return cols;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnsProp, isSchemaMode, view?.fields, schema, rowActions, onAction, selectable, stateMeta, resolveLabel, hasEditableFields, editingCell, startEditing, saveEdit, cancelEditing]);

  // ── Table ─────────────────────────────────────────────────────────────

  const effectivePageSize = pageSizeProp ?? view?.pageSize ?? 20;

  const table = useReactTable({
    data: filteredData,
    columns,
    state: { sorting, columnFilters, globalFilter, rowSelection },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    onRowSelectionChange: setRowSelection,
    enableRowSelection: selectable && isSchemaMode,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: effectivePageSize } },
  });

  const hasActiveFilters = globalFilter !== "" || bazzaFilterState.length > 0 || !!aiSearchState.result;

  const selectedRows = table.getFilteredSelectedRowModel().rows;
  const selectedIds = useMemo(
    () => selectedRows.map((r) => String(r.original.id ?? "")),
    [selectedRows],
  );

  const handleClearAllFilters = useCallback(() => {
    setColumnFilters([]);
    setBazzaFilters([]);
    setGlobalFilter("");
    clearAISearch();
  }, [clearAISearch]);

  // ── CSV export (schema mode only) ─────────────────────────────────────

  const handleExportCsv = useCallback(() => {
    if (!isSchemaMode) return;
    const rows = table.getFilteredRowModel().rows.map((r) => r.original);
    exportCsv({ fields: view.fields, data: rows, schemaName: schema.name, resolveLabel });
  }, [isSchemaMode, table, view?.fields, schema?.name, resolveLabel]);

  const handleExportSelected = useCallback(() => {
    if (!isSchemaMode) return;
    const rows = selectedRows.map((r) => r.original);
    exportCsv({ fields: view.fields, data: rows, schemaName: schema.name, resolveLabel });
  }, [isSchemaMode, selectedRows, view?.fields, schema?.name, resolveLabel]);

  const handleBulkAction = useCallback(
    (actionName: string) => {
      if (actionName === "export") {
        handleExportSelected();
        return;
      }
      if (actionName === "edit") {
        setBulkEditOpen(true);
        return;
      }
      onBulkAction?.(actionName, selectedIds);
    },
    [handleExportSelected, onBulkAction, selectedIds],
  );

  // ── Loading skeleton ──────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <Skeleton className="h-9 w-72" />
          <Skeleton className="h-9 w-20" />
        </div>
        <div className="rounded border border-border">
          {isSchemaMode && (
            <div className="flex items-center gap-4 border-b border-border bg-muted/50 px-3 py-2.5">
              {selectable && <Skeleton className="h-4 w-4" />}
              {view.fields.slice(0, 5).map((f, i) => (
                <Skeleton key={f.field} className="h-4" style={{ width: `${80 + i * 16}px` }} />
              ))}
            </div>
          )}
          {SKELETON_KEYS.map((key) => (
            <div key={key} className="flex items-center gap-4 border-b border-border last:border-0 px-3 py-2.5">
              {isSchemaMode && selectable && <Skeleton className="h-4 w-4" />}
              {isSchemaMode ? (
                view.fields.slice(0, 5).map((f, i) => (
                  <Skeleton key={f.field} className="h-4" style={{ width: `${60 + i * 20}px` }} />
                ))
              ) : (
                <>
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-4 w-20" />
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ── Empty state (when configured) ─────────────────────────────────────

  if (data.length === 0 && !hasActiveFilters && emptyState) {
    return (
      <EmptyState
        title={emptyState.title}
        description={emptyState.description}
        icon={emptyState.icon}
        hideAction
      />
    );
  }

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      <ListToolbar
        schema={isSchemaMode ? schema : undefined}
        globalFilter={globalFilter}
        onGlobalFilterChange={isSchemaMode ? handleGlobalFilterChange : setGlobalFilter}
        hasActiveFilters={hasActiveFilters}
        onClearFilters={isSchemaMode ? handleClearAllFilters : () => setGlobalFilter("")}
        toolbarActions={toolbarActions}
        onAction={isSchemaMode ? onAction : undefined}
        selectedCount={isSchemaMode ? selectedIds.length : undefined}
        onExportCsv={isSchemaMode ? handleExportCsv : undefined}
        onImport={isSchemaMode ? () => setImportOpen(true) : undefined}
        onBulkAction={isSchemaMode ? handleBulkAction : undefined}
        onClearSelection={isSchemaMode ? () => setRowSelection({}) : undefined}
        bazzaColumns={isSchemaMode ? bazzaColumns : undefined}
        bazzaFilters={isSchemaMode ? bazzaFilterState : undefined}
        bazzaActions={isSchemaMode ? bazzaActions : undefined}
        bazzaStrategy={isSchemaMode ? bazzaStrategy : undefined}
        toolbarExtra={toolbarExtra}
        aiSearchState={isSchemaMode ? aiSearchState : undefined}
        onClearAISearch={isSchemaMode ? clearAISearch : undefined}
        onSearchSubmit={isSchemaMode ? handleSearchSubmit : undefined}
        onRefresh={onRefresh}
        refreshing={refreshing}
      />

      <TableShell
        table={table}
        columns={columns}
        onRowClick={onRowClick}
        hasActiveFilters={hasActiveFilters}
      />

      {isSchemaMode && (
        <>
          <ImportDialog
            open={importOpen}
            onOpenChange={setImportOpen}
            schema={schema}
            onImported={onRefresh}
          />

          <BulkEditDialog
            open={bulkEditOpen}
            onOpenChange={setBulkEditOpen}
            schema={schema}
            selectedIds={selectedIds}
            queryFields={queryFields}
            onCompleted={() => {
              setRowSelection({});
              onRefresh?.();
            }}
          />
        </>
      )}
    </div>
  );
}

/**
 * Sortable column header — reusable across column defs (admin and schema pages).
 * Usage: `header: ({ column }) => <SortableHeader column={column} label="Name" />`
 */
export function SortableHeader({
  column,
  label,
}: {
  column: { getIsSorted: () => false | "asc" | "desc"; toggleSorting: (desc: boolean) => void };
  label: string;
}) {
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
}
