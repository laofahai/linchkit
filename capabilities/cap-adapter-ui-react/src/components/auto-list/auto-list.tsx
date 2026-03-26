/**
 * AutoList — Schema-driven list view powered by TanStack Table.
 *
 * Orchestrates: toolbar (search + filter), table rendering, pagination.
 * Uses bazza/ui DataTableFilter for column filtering (integrated into SearchBar).
 * Supports AI-powered natural language search via useAISearch hook.
 */

import { Skeleton } from "@linchkit/ui-kit/components";
import { cn } from "@linchkit/ui-kit/lib/utils";
import {
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
import { Inbox } from "lucide-react";
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
import { ListPagination } from "./list-pagination";
import { ListToolbar } from "./list-toolbar";
import type { AutoListProps } from "./types";

/** Stable keys for skeleton placeholder rows (avoids array-index-as-key). */
const SKELETON_KEYS = ["skel-1", "skel-2", "skel-3", "skel-4", "skel-5"] as const;

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
    case "gt":
      return Number(rowVal) > Number(value);
    case "gte":
      return Number(rowVal) >= Number(value);
    case "lt":
      return Number(rowVal) < Number(value);
    case "lte":
      return Number(rowVal) <= Number(value);
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
      const n = Number(rowVal);
      return n >= Number(arr[0]) && n <= Number(arr[1]);
    }
    case "is_null":
      return rowVal === null || rowVal === undefined;
    case "not_null":
      return rowVal !== null && rowVal !== undefined;
    default:
      return true;
  }
}

export function AutoList({
  schema,
  view,
  data,
  loading = false,
  title: _title,
  stateMeta,
  onAction,
  onBulkAction,
  onRowClick,
  selectable = false,
  toolbarExtra,
  onInlineEditSaved,
  onInlineEditError,
}: AutoListProps) {
  const { t } = useTranslation();
  const { resolveLabel } = useSchemaLabel();

  const [sorting, setSorting] = useState<SortingState>(() => {
    if (view.defaultSort) {
      return [{ id: view.defaultSort.field, desc: view.defaultSort.order === "desc" }];
    }
    return [];
  });
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});

  // AI search hook
  const {
    aiSearch: aiSearchState,
    triggerAISearch,
    clearAISearch,
  } = useAISearch(schema);

  // Handle search submission (Enter key)
  const handleSearchSubmit = useCallback(
    (query: string) => {
      if (isNaturalLanguageQuery(query)) {
        triggerAISearch(query);
      }
    },
    [triggerAISearch],
  );

  // Clear AI search when global filter text changes (user is typing)
  const handleGlobalFilterChange = useCallback(
    (value: string) => {
      setGlobalFilter(value);
      // Don't auto-clear AI filter on every keystroke; only when text is cleared
      if (!value && aiSearchState.result) {
        // Keep AI filter active — user can explicitly clear via chip
      }
    },
    [aiSearchState.result],
  );

  // Bazza filter column configs from schema
  const filterColumnsConfig = useMemo(
    () => buildFilterColumns(schema, data, stateMeta, resolveLabel),
    [schema, data, stateMeta, resolveLabel],
  );

  // Bazza filter state
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

  const toolbarActions = useMemo(
    () => (view.actions ?? []).filter((a) => a.position === "toolbar"),
    [view.actions],
  );
  const rowActions = useMemo(
    () => (view.actions ?? []).filter((a) => a.position === "row"),
    [view.actions],
  );

  // Determine if any field has inline editing enabled
  const hasEditableFields = useMemo(
    () => view.fields.some((f) => f.editable),
    [view.fields],
  );

  // Query fields for refetching after inline edit
  const queryFields = useMemo(
    () => ["id", ...view.fields.map((f) => f.field)],
    [view.fields],
  );

  // Inline edit hook
  const {
    editingCell,
    startEditing,
    cancelEditing,
    saveEdit,
  } = useInlineEdit({
    schemaName: schema.name,
    queryFields,
    onSaved: onInlineEditSaved,
    onError: onInlineEditError,
  });

  // Pre-filter data using bazza filter logic + AI filter before passing to TanStack Table
  const filteredData = useMemo(() => {
    let result = data;

    // Apply bazza filters
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

  const columns = useMemo(() => {
    const cols = buildColumns({
      fields: view.fields,
      schema,
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
  }, [view.fields, schema, rowActions, onAction, selectable, stateMeta, resolveLabel, hasEditableFields, editingCell, startEditing, saveEdit, cancelEditing]);

  const table = useReactTable({
    data: filteredData,
    columns,
    state: { sorting, columnFilters, globalFilter, rowSelection },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    onRowSelectionChange: setRowSelection,
    enableRowSelection: selectable,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: view.pageSize ?? 10 } },
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

  // CSV export: all filtered rows
  const handleExportCsv = useCallback(() => {
    const rows = table.getFilteredRowModel().rows.map((r) => r.original);
    exportCsv({ fields: view.fields, data: rows, schemaName: schema.name, resolveLabel });
  }, [table, view.fields, schema.name, resolveLabel]);

  // CSV export: selected rows only
  const handleExportSelected = useCallback(() => {
    const rows = selectedRows.map((r) => r.original);
    exportCsv({ fields: view.fields, data: rows, schemaName: schema.name, resolveLabel });
  }, [selectedRows, view.fields, schema.name, resolveLabel]);

  // Intercept bulk actions to handle export internally
  const handleBulkAction = useCallback(
    (actionName: string) => {
      if (actionName === "export") {
        handleExportSelected();
        return;
      }
      onBulkAction?.(actionName, selectedIds);
    },
    [handleExportSelected, onBulkAction, selectedIds],
  );

  if (loading) {
    return (
      <div className="space-y-4">
        {/* Toolbar skeleton */}
        <div className="flex items-center justify-between gap-3">
          <Skeleton className="h-9 w-72" />
          <Skeleton className="h-9 w-20" />
        </div>
        {/* Table skeleton with header + rows */}
        <div className="rounded border border-border">
          <div className="flex items-center gap-4 border-b border-border bg-muted/50 px-3 py-2.5">
            {selectable && <Skeleton className="h-4 w-4" />}
            {view.fields.slice(0, 5).map((f, i) => (
              <Skeleton key={f.field} className="h-4" style={{ width: `${80 + i * 16}px` }} />
            ))}
          </div>
          {SKELETON_KEYS.map((key) => (
            <div key={key} className="flex items-center gap-4 border-b border-border last:border-0 px-3 py-2.5">
              {selectable && <Skeleton className="h-4 w-4" />}
              {view.fields.slice(0, 5).map((f, i) => (
                <Skeleton key={f.field} className="h-4" style={{ width: `${60 + i * 20}px` }} />
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ListToolbar
        schema={schema}
        globalFilter={globalFilter}
        onGlobalFilterChange={handleGlobalFilterChange}
        hasActiveFilters={hasActiveFilters}
        onClearFilters={handleClearAllFilters}
        toolbarActions={toolbarActions}
        onAction={onAction}
        selectedCount={selectedIds.length}
        onExportCsv={handleExportCsv}
        onBulkAction={handleBulkAction}
        onClearSelection={() => setRowSelection({})}
        bazzaColumns={bazzaColumns}
        bazzaFilters={bazzaFilterState}
        bazzaActions={bazzaActions}
        bazzaStrategy={bazzaStrategy}
        toolbarExtra={toolbarExtra}
        aiSearchState={aiSearchState}
        onClearAISearch={clearAISearch}
        onSearchSubmit={handleSearchSubmit}
      />

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
                    const id = String(row.original.id ?? "");
                    if (id && onRowClick) onRowClick(id);
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
    </div>
  );
}
