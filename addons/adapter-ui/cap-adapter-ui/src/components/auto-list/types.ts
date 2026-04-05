import type {
  EntityDefinition,
  StateMeta,
  ViewAction,
  ViewFieldConfig,
} from "@linchkit/core/types";
import type { ColumnDef, SortingState } from "@tanstack/react-table";

export interface ViewFilter {
  field: string;
  type: ViewFilterType;
  label?: string;
  placeholder?: string;
  options?: { value: string; label: string }[];
}

export type ViewFilterType = "text" | "select" | "dateRange";

export interface AutoListViewDefinition {
  name: string;
  entity: string;
  type: "list";
  label?: string;
  description?: string;
  fields: ViewFieldConfig[];
  filters?: ViewFilter[];
  actions?: ViewAction[];
  defaultSort?: { field: string; order: "asc" | "desc" };
  pageSize?: number;
  /** Custom route for row click navigation. Supports {id} and {name} placeholders. */
  rowActionRoute?: string;
}

/** Serializable filter entry used by saved views. */
export interface SavedFilterEntry {
  field: string;
  operator: string;
  values: unknown[];
}

/** Configuration for the empty state displayed when data array is empty. */
export interface EmptyStateConfig {
  /** Override title text. */
  title?: string;
  /** Override description text. */
  description?: string;
  /** Override icon element. */
  icon?: React.ReactNode;
}

/**
 * Unified AutoList props.
 *
 * Modes (determined by which props are provided):
 * - Schema-driven: `schema` + `view` — auto-builds columns, enables AI search,
 *   bazza filters, inline edit, CSV export, import, bulk edit.
 * - Manual columns: `columns` — raw ColumnDef[] for admin/non-schema pages.
 * - Hybrid: `schema` + `view` + `columns` — schema features with custom columns.
 *
 * All modes share identical table rendering, sorting, global filtering, pagination,
 * and toolbar.
 */
export interface AutoListProps {
  /** Row data. Always required. */
  data: Record<string, unknown>[];
  loading?: boolean;
  title?: string;
  onRowClick?: (recordId: string) => void;
  /** Extra content rendered after the primary action button in the toolbar. */
  toolbarExtra?: React.ReactNode;
  /** Callback to trigger data refresh. */
  onRefresh?: () => void;
  /** Whether a refresh is currently in progress (shows spinning icon on refresh button). */
  refreshing?: boolean;
  /** Empty state configuration shown when data is empty and not loading. */
  emptyState?: EmptyStateConfig;

  // ── Schema-driven props (optional) ────────────────────────────────────────

  /** Schema definition. When provided with `view`, enables schema-driven features. */
  schema?: EntityDefinition;
  /** View definition. Required alongside `schema` for auto-column generation. */
  view?: AutoListViewDefinition;
  stateMeta?: Partial<Record<string, StateMeta>>;
  onAction?: (actionName: string, recordId: string) => void;
  onBulkAction?: (actionName: string, recordIds: string[]) => void;
  selectable?: boolean;
  onInlineEditSaved?: (recordId: string, updatedRecord: Record<string, unknown>) => void;
  onInlineEditError?: (error: Error) => void;
  /** Callback fired when the active bazza filter state changes. Used by saved views. */
  onFiltersChange?: (filters: SavedFilterEntry[]) => void;

  // ── Controlled filter state (optional) ─────────────────────────────────────
  // When provided, AutoList uses these instead of its own internal state.
  // This allows the parent to share filter state across list and alternate views.

  /** Controlled global text filter value. */
  globalFilter?: string;
  /** Controlled global text filter change handler. */
  onGlobalFilterChange?: (value: string) => void;

  // ── Column override (optional) ────────────────────────────────────────────

  /** Raw TanStack Table column definitions. When provided, overrides auto-generated columns from `view`. */
  columns?: ColumnDef<Record<string, unknown>, unknown>[];
  /** Page size for pagination (default: from view.pageSize, or 20). */
  pageSize?: number;
  /** Default sorting state (used when no view.defaultSort is available). */
  defaultSorting?: SortingState;

  // ── Server-side pagination + sorting (optional) ──────────────────────────

  /** Total row count from server. When provided, enables manual (server-side) pagination. */
  serverTotal?: number;
  /** Callback when pagination state changes (server-side pagination mode). */
  onPaginationChange?: (page: number, pageSize: number) => void;
  /** Callback when sorting state changes (server-side sorting mode). */
  onSortingChange?: (sorting: SortingState) => void;
}
