import type { SchemaDefinition, ViewAction } from "@linchkit/core";
import { ChevronDown, Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Input } from "../ui/input";
import { getEnumOptions } from "./columns";
import type { ViewFilter } from "./types";

interface ListToolbarProps {
  /** Title displayed in the header row. */
  title?: string;
  filters: ViewFilter[];
  schema: SchemaDefinition;
  globalFilter: string;
  onGlobalFilterChange: (value: string) => void;
  getColumnFilterValue: (field: string) => string;
  onColumnFilterChange: (field: string, value: string | undefined) => void;
  hasActiveFilters: boolean;
  onClearFilters: () => void;
  toolbarActions: ViewAction[];
  onAction?: (actionName: string, recordId: string) => void;
  /** Number of currently selected rows. */
  selectedCount?: number;
  /** Bulk action callback for selected rows. */
  onBulkAction?: (actionName: string) => void;
  /** Clear current selection. */
  onClearSelection?: () => void;
}

/**
 * ListToolbar — Two-row control panel for AutoList.
 *
 * Row 1: Title (left) + primary actions (right)
 * Row 2: Search input + filter selects + clear button
 */
export function ListToolbar({
  title,
  filters,
  schema,
  globalFilter,
  onGlobalFilterChange,
  getColumnFilterValue,
  onColumnFilterChange,
  hasActiveFilters,
  onClearFilters,
  toolbarActions,
  onAction,
  selectedCount = 0,
  onBulkAction,
  onClearSelection,
}: ListToolbarProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-3">
      {/* Row 1: Title + primary actions */}
      <div className="flex items-center justify-between">
        {title && (
          <h1 className="text-xl font-semibold text-foreground">{title}</h1>
        )}
        <div className="flex items-center gap-2">
          {/* Bulk actions dropdown — visible when rows are selected */}
          {selectedCount > 0 && (
            <>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm">
                    {selectedCount} {t("list.selected")}
                    <ChevronDown className="ml-1 size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onClick={() => onBulkAction?.("export")}
                  >
                    {t("common.export")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-destructive"
                    onClick={() => onBulkAction?.("delete")}
                  >
                    {t("common.delete")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                variant="ghost"
                size="sm"
                className="text-xs text-muted-foreground"
                onClick={onClearSelection}
              >
                <X className="mr-1 size-3" />
                {t("common.cancel")}
              </Button>
            </>
          )}
          {toolbarActions.map((a) => (
            <Button
              key={a.action}
              variant={
                a.variant === "destructive" ? "destructive" : "default"
              }
              size="sm"
              onClick={() => onAction?.(a.action, "")}
            >
              {a.label ?? a.action}
            </Button>
          ))}
        </div>
      </div>

      {/* Row 2: Search + filters */}
      <div className="flex items-center gap-2 border-b border-border pb-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={`${t("common.search")}...`}
            value={globalFilter}
            onChange={(e) => onGlobalFilterChange(e.target.value)}
            className="h-7 w-64 pl-8 text-sm"
          />
        </div>
        {filters.map((filter) => {
          if (filter.type === "select") {
            const options =
              filter.options ?? getEnumOptions(schema.fields[filter.field]);
            return (
              <select
                key={filter.field}
                className="h-7 rounded-md border border-input bg-background px-2 text-xs"
                value={getColumnFilterValue(filter.field)}
                onChange={(e) =>
                  onColumnFilterChange(
                    filter.field,
                    e.target.value || undefined,
                  )
                }
              >
                <option value="">{filter.label ?? filter.field}</option>
                {options.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            );
          }
          return null;
        })}
        {hasActiveFilters && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground"
            onClick={onClearFilters}
          >
            <X className="mr-1 size-3" />
            {t("common.reset")}
          </Button>
        )}
      </div>
    </div>
  );
}
