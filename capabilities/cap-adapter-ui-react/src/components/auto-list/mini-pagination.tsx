import { Button } from "@linchkit/ui-kit/components";
import type { Table } from "@tanstack/react-table";
import { ChevronLeft, ChevronRight } from "lucide-react";

interface MiniPaginationProps {
  table: Table<Record<string, unknown>>;
}

/**
 * MiniPagination — Compact Odoo-style pagination indicator.
 *
 * Shows "1-20 / 156" with prev/next arrows. Designed to sit in the toolbar
 * area next to action buttons.
 */
export function MiniPagination({ table }: MiniPaginationProps) {
  const { pageIndex, pageSize } = table.getState().pagination;
  const totalRows = table.getFilteredRowModel().rows.length;

  if (totalRows === 0) return null;

  const start = pageIndex * pageSize + 1;
  const end = Math.min((pageIndex + 1) * pageSize, totalRows);

  return (
    <div className="flex items-center gap-0.5 text-sm text-muted-foreground">
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={!table.getCanPreviousPage()}
        onClick={() => table.previousPage()}
      >
        <ChevronLeft className="size-4" />
      </Button>
      <span className="tabular-nums whitespace-nowrap px-1">
        {start}-{end} / {totalRows}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={!table.getCanNextPage()}
        onClick={() => table.nextPage()}
      >
        <ChevronRight className="size-4" />
      </Button>
    </div>
  );
}
