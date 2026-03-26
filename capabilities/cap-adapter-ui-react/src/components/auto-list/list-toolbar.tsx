import type { SchemaDefinition, ViewAction } from "@linchkit/core/types";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@linchkit/ui-kit/components";
import { ChevronDown, Columns3, Download, MoreHorizontal, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSchemaLabel } from "../../i18n/use-schema-label";
import type {
  Column,
  DataTableFilterActions,
  FilterStrategy,
  FiltersState,
} from "../data-table-filter/core/types";
import { SearchBar } from "./search-bar";

interface ListToolbarProps {
  title?: string;
  schema: SchemaDefinition;
  globalFilter: string;
  onGlobalFilterChange: (value: string) => void;
  hasActiveFilters: boolean;
  onClearFilters: () => void;
  toolbarActions: ViewAction[];
  onAction?: (actionName: string, recordId: string) => void;
  selectedCount?: number;
  onBulkAction?: (actionName: string) => void;
  onClearSelection?: () => void;
  /** bazza filter props passed through to SearchBar */
  bazzaColumns?: Column<Record<string, unknown>>[] | undefined;
  bazzaFilters?: FiltersState | undefined;
  bazzaActions?: DataTableFilterActions | undefined;
  bazzaStrategy?: FilterStrategy | undefined;
  /** Extra content rendered after the primary action button. */
  toolbarExtra?: React.ReactNode;
}

/**
 * ListToolbar — Single-row toolbar for AutoList.
 *
 * Layout: SearchBar (search + filters unified) | spacer | Actions
 */
export function ListToolbar({
  schema,
  globalFilter,
  onGlobalFilterChange,
  hasActiveFilters,
  onClearFilters,
  toolbarActions,
  onAction,
  selectedCount = 0,
  onBulkAction,
  onClearSelection,
  bazzaColumns,
  bazzaFilters,
  bazzaActions,
  bazzaStrategy,
  toolbarExtra,
}: ListToolbarProps) {
  const { t } = useTranslation();
  const { resolveLabel } = useSchemaLabel();

  const primaryAction = toolbarActions[0];
  const overflowActions = toolbarActions.slice(1);

  return (
    <div className="flex items-center gap-3">
      {/* Left: Unified SearchBar */}
      <SearchBar
        schema={schema}
        globalFilter={globalFilter}
        onGlobalFilterChange={onGlobalFilterChange}
        onClearAll={hasActiveFilters ? onClearFilters : undefined}
        bazzaColumns={bazzaColumns}
        bazzaFilters={bazzaFilters}
        bazzaActions={bazzaActions}
        bazzaStrategy={bazzaStrategy}
        className="max-w-md"
      />

      <div className="flex-1" />

      {/* Right: Actions */}
      <div className="flex shrink-0 items-center gap-2">
        {/* Bulk actions */}
        {selectedCount > 0 && (
          <>
            <span className="text-sm text-muted-foreground">
              {selectedCount} {t("list.selected")}
            </span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  {t("common.actions")}
                  <ChevronDown className="ml-1 size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => onBulkAction?.("export")}>
                  <Download className="mr-2 size-3.5" />
                  {t("common.export")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive"
                  onClick={() => onBulkAction?.("delete")}
                >
                  <Trash2 className="mr-2 size-3.5" />
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
              <X className="size-3" />
            </Button>
          </>
        )}

        {/* Primary action */}
        {primaryAction && (
          <Button
            variant={primaryAction.variant === "destructive" ? "destructive" : "default"}
            size="sm"
            onClick={() => onAction?.(primaryAction.action, "")}
          >
            {resolveLabel(primaryAction.label, primaryAction.action)}
          </Button>
        )}

        {/* Extra toolbar content (e.g. view toggle) */}
        {toolbarExtra}

        {/* Overflow menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm">
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {overflowActions.map((a) => (
              <DropdownMenuItem key={a.action} onClick={() => onAction?.(a.action, "")}>
                {resolveLabel(a.label, a.action)}
              </DropdownMenuItem>
            ))}
            {overflowActions.length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem disabled>
              <Columns3 className="mr-2 size-3.5" />
              {t("list.columns", "Columns")}
            </DropdownMenuItem>
            <DropdownMenuItem disabled>
              <Download className="mr-2 size-3.5" />
              {t("common.export", "Export")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
