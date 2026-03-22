import type { SchemaDefinition, StateMeta, ViewAction, ViewFieldConfig } from "@linchkit/core/types";

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

export interface AutoListProps {
  schema: SchemaDefinition;
  view: AutoListViewDefinition;
  data: Record<string, unknown>[];
  loading?: boolean;
  title?: string;
  stateMeta?: Partial<Record<string, StateMeta>>;
  onAction?: (actionName: string, recordId: string) => void;
  onBulkAction?: (actionName: string, recordIds: string[]) => void;
  onRowClick?: (recordId: string) => void;
  selectable?: boolean;
}
