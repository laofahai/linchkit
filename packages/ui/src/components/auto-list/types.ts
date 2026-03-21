import type {
  SchemaDefinition,
  ViewAction,
  ViewFieldConfig,
} from "@linchkit/core";

export interface ViewFilter {
  field: string;
  type: ViewFilterType;
  label?: string;
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

export interface AutoListProps {
  schema: SchemaDefinition;
  view: AutoListViewDefinition;
  data: Record<string, unknown>[];
  loading?: boolean;
  /** Optional title rendered inline in the toolbar row. */
  title?: string;
  onAction?: (actionName: string, recordId: string) => void;
  /** Callback for bulk actions on selected rows. */
  onBulkAction?: (actionName: string, recordIds: string[]) => void;
  onRowClick?: (recordId: string) => void;
  /** Enable row selection with checkboxes. Defaults to false. */
  selectable?: boolean;
}
