import type { ColumnDef, SortingState } from "@tanstack/react-table";
import type {
  SchemaDefinition,
  StateMeta,
  ViewAction,
  ViewFieldConfig,
} from "@linchkit/core/types";

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
  schema: string;
  type: "list";
  label?: string;
  description?: string;
  fields: ViewFieldConfig[];
  filters?: ViewFilter[];
  actions?: ViewAction[];
  defaultSort?: { field: string; order: "asc" | "desc" };
  pageSize?: number;
}

/** Base props shared by both schema-driven and external-columns modes. */
interface AutoListBaseProps {
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

/** Schema-driven mode — uses ViewDefinition + SchemaDefinition to build columns automatically. */
interface AutoListSchemaProps extends AutoListBaseProps {
  schema: SchemaDefinition;
  view: AutoListViewDefinition;
  stateMeta?: Partial<Record<string, StateMeta>>;
  onAction?: (actionName: string, recordId: string) => void;
  onBulkAction?: (actionName: string, recordIds: string[]) => void;
  selectable?: boolean;
  onInlineEditSaved?: (recordId: string, updatedRecord: Record<string, unknown>) => void;
  onInlineEditError?: (error: Error) => void;
  /** Callback fired when the active bazza filter state changes. Used by saved views. */
  onFiltersChange?: (filters: SavedFilterEntry[]) => void;
  /** Must not be set in schema mode. */
  externalColumns?: never;
}

/** External-columns mode — caller provides raw TanStack ColumnDef[], no schema required. */
interface AutoListExternalProps extends AutoListBaseProps {
  /** Raw TanStack Table column definitions. When provided, schema/view are not required. */
  externalColumns: ColumnDef<Record<string, unknown>, unknown>[];
  /** Page size for pagination (default 20). */
  pageSize?: number;
  /** Default sorting state. */
  defaultSorting?: SortingState;
  /** Empty state configuration shown when data is empty and not loading. */
  emptyState?: EmptyStateConfig;
  /** Not used in external-columns mode. */
  schema?: never;
  view?: never;
  stateMeta?: never;
  onAction?: never;
  onBulkAction?: never;
  selectable?: never;
  onInlineEditSaved?: never;
  onInlineEditError?: never;
}

export type AutoListProps = AutoListSchemaProps | AutoListExternalProps;
