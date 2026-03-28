/**
 * SearchBar — Unified search + filter component (Odoo Search View equivalent).
 *
 * Combines:
 * - Global fuzzy text search (free text input)
 * - AI-powered natural language search (detects NL queries automatically)
 * - bazza DataTableFilter (field-level filtering with pills)
 * - All applied conditions as inline chips
 */

import type { SchemaDefinition } from "@linchkit/core/types";
import { Tooltip, TooltipContent, TooltipTrigger } from "@linchkit/ui-kit/components";
import { cn } from "@linchkit/ui-kit/lib/utils";
import { Loader2, Search, Sparkles, X } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AISearchState } from "../../hooks/use-ai-search";
import { ActiveFilters } from "../data-table-filter/components/active-filters";
import { FilterSelector } from "../data-table-filter/components/filter-selector";
import type {
  Column,
  DataTableFilterActions,
  FilterStrategy,
  FiltersState,
} from "../data-table-filter/core/types";

export interface SearchBarProps {
  schema?: SchemaDefinition;
  /** Global text filter */
  globalFilter: string;
  onGlobalFilterChange: (value: string) => void;
  /** Clear all (text + filters) */
  onClearAll?: () => void;
  /** bazza filter integration */
  bazzaColumns?: Column<Record<string, unknown>>[];
  bazzaFilters?: FiltersState;
  bazzaActions?: DataTableFilterActions;
  bazzaStrategy?: FilterStrategy;
  /** AI search state */
  aiSearchState?: AISearchState;
  /** Callback to clear AI search filter */
  onClearAISearch?: () => void;
  /** Callback when Enter is pressed (used for AI search trigger) */
  onSubmit?: (query: string) => void;
  /** Additional class names */
  className?: string;
}

export function SearchBar({
  globalFilter,
  onGlobalFilterChange,
  onClearAll,
  bazzaColumns,
  bazzaFilters,
  bazzaActions,
  bazzaStrategy,
  aiSearchState,
  onClearAISearch,
  onSubmit,
  className,
}: SearchBarProps) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);

  const hasFilters = (bazzaFilters?.length ?? 0) > 0;
  const hasText = globalFilter.length > 0;
  const hasAIFilter = !!aiSearchState?.result;
  const isAILoading = !!aiSearchState?.loading;
  const hasContent = hasText || hasFilters || hasAIFilter;

  const handleBarClick = (e: React.MouseEvent<HTMLElement> | React.KeyboardEvent<HTMLElement>) => {
    const target = e.target as HTMLElement;
    if (
      target === e.currentTarget ||
      target.tagName === "svg" ||
      (target.closest("search") === e.currentTarget && !target.closest("button"))
    ) {
      inputRef.current?.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && globalFilter.trim()) {
      e.preventDefault();
      onSubmit?.(globalFilter.trim());
    }
  };

  return (
    <search
      className={cn(
        "flex h-9 items-center gap-1.5 rounded-md border border-input bg-background px-2 transition-colors",
        focused && "ring-1 ring-ring",
        hasAIFilter && "border-violet-400 dark:border-violet-600",
        className,
      )}
      onClick={handleBarClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") handleBarClick(e);
      }}
    >
      {/* Search icon or loading spinner */}
      {isAILoading ? (
        <Loader2 className="size-3.5 shrink-0 animate-spin text-violet-500" />
      ) : (
        <Search className="size-3.5 shrink-0 text-muted-foreground" />
      )}

      {/* AI filter chip */}
      {hasAIFilter && aiSearchState?.result && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center gap-1 shrink-0 rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-700 dark:bg-violet-900/40 dark:text-violet-300"
              onClick={(e) => {
                e.stopPropagation();
                onClearAISearch?.();
              }}
            >
              <Sparkles className="size-3" />
              {t("aiSearch.chipLabel", "AI Filter")}
              <X className="size-3 ml-0.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-[300px]">
            <p className="text-xs">{aiSearchState.result.explanation}</p>
          </TooltipContent>
        </Tooltip>
      )}

      {/* bazza filter pills (inline) */}
      {bazzaColumns && bazzaFilters && bazzaActions && bazzaStrategy && hasFilters && (
        <div className="flex items-center gap-1.5 shrink-0">
          <ActiveFilters
            columns={bazzaColumns}
            filters={bazzaFilters}
            actions={bazzaActions}
            strategy={bazzaStrategy}
          />
        </div>
      )}

      {/* Text input */}
      <input
        ref={inputRef}
        type="text"
        value={globalFilter}
        onChange={(e) => onGlobalFilterChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={handleKeyDown}
        placeholder={hasFilters || hasAIFilter ? "" : `${t("common.search")}...`}
        className="h-8 min-w-[80px] flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      />

      {/* bazza filter selector (add filter button) */}
      {bazzaColumns && bazzaFilters && bazzaActions && bazzaStrategy && (
        <div className="shrink-0">
          <FilterSelector
            columns={bazzaColumns}
            filters={bazzaFilters}
            actions={bazzaActions}
            strategy={bazzaStrategy}
          />
        </div>
      )}

      {/* Clear all */}
      {hasContent && (onClearAll || onClearAISearch) && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onGlobalFilterChange("");
            onClearAll?.();
            onClearAISearch?.();
            inputRef.current?.focus();
          }}
          className="shrink-0 rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      )}
    </search>
  );
}
