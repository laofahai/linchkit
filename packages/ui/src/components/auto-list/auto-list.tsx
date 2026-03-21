/**
 * AutoList — Schema-driven list view powered by TanStack Table.
 *
 * Orchestrates: columns, toolbar, table rendering, pagination.
 * Sub-components handle individual concerns.
 */

import {
  type ColumnFiltersState,
  type RowSelectionState,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { Inbox } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";
import { Skeleton } from "../ui/skeleton";
import { buildColumns, buildSelectionColumn } from "./columns";
import { ListPagination } from "./list-pagination";
import { ListToolbar } from "./list-toolbar";
import type { AutoListProps } from "./types";

export function AutoList({
  schema,
  view,
  data,
  loading = false,
  title,
  stateMeta,
  onAction,
  onBulkAction,
  onRowClick,
  selectable = false,
}: AutoListProps) {
  const { t } = useTranslation();

  const [sorting, setSorting] = useState<SortingState>(() => {
    if (view.defaultSort) {
      return [
        {
          id: view.defaultSort.field,
          desc: view.defaultSort.order === "desc",
        },
      ];
    }
    return [];
  });
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});

  // Clear selection when filters change
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset on filter change
  useEffect(() => {
    setRowSelection({});
  }, [columnFilters, globalFilter]);

  const toolbarActions = useMemo(
    () => (view.actions ?? []).filter((a) => a.position === "toolbar"),
    [view.actions],
  );
  const rowActions = useMemo(
    () => (view.actions ?? []).filter((a) => a.position === "row"),
    [view.actions],
  );

  const columns = useMemo(() => {
    const cols = buildColumns({ fields: view.fields, schema, rowActions, onAction, stateMeta });
    if (selectable) {
      cols.unshift(buildSelectionColumn());
    }
    return cols;
  }, [view.fields, schema, rowActions, onAction, selectable]);

  const table = useReactTable({
    data,
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
    initialState: {
      pagination: { pageSize: view.pageSize ?? 10 },
    },
  });

  const filters = view.filters ?? [];
  const hasActiveFilters = columnFilters.length > 0 || globalFilter !== "";

  const selectedRows = table.getFilteredSelectedRowModel().rows;
  const selectedIds = useMemo(
    () => selectedRows.map((r) => String(r.original.id ?? "")),
    [selectedRows],
  );

  if (loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={`skel-${i}`} className="h-10 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ListToolbar
        title={title}
        filters={filters}
        schema={schema}
        globalFilter={globalFilter}
        onGlobalFilterChange={setGlobalFilter}
        getColumnFilterValue={(field) =>
          (table.getColumn(field)?.getFilterValue() as string) ?? ""
        }
        onColumnFilterChange={(field, value) =>
          table.getColumn(field)?.setFilterValue(value)
        }
        hasActiveFilters={hasActiveFilters}
        onClearFilters={() => {
          setColumnFilters([]);
          setGlobalFilter("");
        }}
        toolbarActions={toolbarActions}
        onAction={onAction}
        selectedCount={selectedIds.length}
        onBulkAction={(actionName) => onBulkAction?.(actionName, selectedIds)}
        onClearSelection={() => setRowSelection({})}
      />

      {/* Table */}
      <div className="rounded border border-border">
        <table className="w-full text-sm">
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr
                key={headerGroup.id}
                className="border-b border-border bg-muted/50"
              >
                {headerGroup.headers.map((header) => (
                  <th
                    key={header.id}
                    className="px-3 py-2 text-left font-medium text-muted-foreground"
                    style={
                      header.getSize() !== 150
                        ? { width: header.getSize() }
                        : undefined
                    }
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
                        )}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length}
                  className="py-12 text-center text-muted-foreground"
                >
                  <Inbox className="mx-auto mb-2 size-8 opacity-40" />
                  <p className="text-sm">{t("list.noRecords")}</p>
                  {hasActiveFilters && (
                    <p className="mt-1 text-xs">{t("list.filterHint")}</p>
                  )}
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
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext(),
                      )}
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
