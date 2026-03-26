/**
 * AdminTable — Lightweight table component for admin pages.
 *
 * Reuses the same table styling, sorting, global filtering, and pagination
 * as AutoList, but accepts raw TanStack Table ColumnDef[] instead of requiring
 * a SchemaDefinition. Ideal for admin pages (executions, proposals, rules, flows)
 * that display non-schema data.
 */

import { Input } from "@linchkit/ui-kit/components";
import { cn } from "@linchkit/ui-kit/lib/utils";
import {
  type ColumnDef,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown, Inbox, SearchIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ListPagination } from "./list-pagination";

/**
 * Sortable column header — reusable across admin table column defs.
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

type DataRow = Record<string, unknown>;

export interface AdminTableProps {
  /** TanStack Table column definitions */
  columns: ColumnDef<DataRow, unknown>[];
  /** Row data */
  data: DataRow[];
  /** Enable global text search across all columns */
  searchable?: boolean;
  /** Placeholder text for the search input */
  searchPlaceholder?: string;
  /** Rows per page (default 20) */
  pageSize?: number;
  /** Callback when a row is clicked */
  onRowClick?: (row: DataRow) => void;
  /** Extra toolbar content rendered after the search input */
  toolbarExtra?: React.ReactNode;
  /** Empty state message override */
  emptyMessage?: string;
  /** Empty state icon override */
  emptyIcon?: React.ReactNode;
  /** Default sorting state */
  defaultSorting?: SortingState;
}

export function AdminTable({
  columns,
  data,
  searchable = true,
  searchPlaceholder,
  pageSize = 20,
  onRowClick,
  toolbarExtra,
  emptyMessage,
  emptyIcon,
  defaultSorting,
}: AdminTableProps) {
  const { t } = useTranslation();
  const [sorting, setSorting] = useState<SortingState>(defaultSorting ?? []);
  const [globalFilter, setGlobalFilter] = useState("");

  const table = useReactTable({
    data,
    columns,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize } },
  });

  return (
    <div className="space-y-4">
      {/* Toolbar: search + extra */}
      {(searchable || toolbarExtra) && (
        <div className="flex items-center justify-between gap-3">
          {searchable && (
            <div className="relative w-72">
              <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <Input
                value={globalFilter}
                onChange={(e) => setGlobalFilter(e.target.value)}
                placeholder={searchPlaceholder ?? t("list.search")}
                className="pl-8 h-7 text-[0.8rem]"
              />
            </div>
          )}
          {toolbarExtra && <div className="flex items-center gap-2">{toolbarExtra}</div>}
        </div>
      )}

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
                  {emptyIcon ?? <Inbox className="mx-auto mb-2 size-8 opacity-40" />}
                  <p className="text-sm">{emptyMessage ?? t("list.noRecords")}</p>
                </td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row) => (
                <tr
                  key={row.id}
                  className={cn(
                    "border-b border-border last:border-0 transition-colors",
                    onRowClick && "cursor-pointer hover:bg-muted/50",
                  )}
                  onClick={() => onRowClick?.(row.original)}
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
