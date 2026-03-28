import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@linchkit/ui-kit/components";
import type { Table } from "@tanstack/react-table";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import { useTranslation } from "react-i18next";

interface ListPaginationProps {
  table: Table<Record<string, unknown>>;
}

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

export function ListPagination({ table }: ListPaginationProps) {
  const { t } = useTranslation();
  const pageCount = table.getPageCount();
  const totalRows = table.getFilteredRowModel().rows.length;
  const { pageIndex, pageSize } = table.getState().pagination;

  if (pageCount <= 1 && totalRows <= (PAGE_SIZE_OPTIONS[0] ?? 10)) return null;

  // Build visible page numbers (show at most 5 around the current page)
  const pages: number[] = [];
  const maxVisible = 5;
  let startPage = Math.max(0, pageIndex - Math.floor(maxVisible / 2));
  const endPage = Math.min(pageCount - 1, startPage + maxVisible - 1);
  // Adjust start if we're near the end
  startPage = Math.max(0, endPage - maxVisible + 1);
  for (let i = startPage; i <= endPage; i++) {
    pages.push(i);
  }

  return (
    <div className="flex items-center justify-between text-sm text-muted-foreground">
      {/* Left: record count + page size selector */}
      <div className="flex items-center gap-3">
        <span>
          {t("list.recordCount", {
            count: totalRows,
          })}
        </span>
        <div className="flex items-center gap-1.5">
          <span className="text-xs">{t("list.pageSize", "Per page")}</span>
          <Select value={String(pageSize)} onValueChange={(val) => table.setPageSize(Number(val))}>
            <SelectTrigger className="h-7 w-[70px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZE_OPTIONS.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Right: page navigation */}
      {pageCount > 1 && (
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon-sm"
            disabled={!table.getCanPreviousPage()}
            onClick={() => table.setPageIndex(0)}
          >
            <ChevronsLeft className="size-3.5" />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            disabled={!table.getCanPreviousPage()}
            onClick={() => table.previousPage()}
          >
            <ChevronLeft className="size-3.5" />
          </Button>

          {/* Page number buttons */}
          {startPage > 0 && <span className="px-1 text-xs text-muted-foreground">...</span>}
          {pages.map((p) => (
            <Button
              key={p}
              variant={p === pageIndex ? "default" : "outline"}
              size="icon-sm"
              className="min-w-7 text-xs"
              onClick={() => table.setPageIndex(p)}
            >
              {p + 1}
            </Button>
          ))}
          {endPage < pageCount - 1 && (
            <span className="px-1 text-xs text-muted-foreground">...</span>
          )}

          <Button
            variant="outline"
            size="icon-sm"
            disabled={!table.getCanNextPage()}
            onClick={() => table.nextPage()}
          >
            <ChevronRight className="size-3.5" />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            disabled={!table.getCanNextPage()}
            onClick={() => table.setPageIndex(table.getPageCount() - 1)}
          >
            <ChevronsRight className="size-3.5" />
          </Button>
        </div>
      )}
    </div>
  );
}
