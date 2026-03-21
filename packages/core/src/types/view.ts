/**
 * View type definitions
 *
 * Headless architecture: logic layer (@linchkit/core) and rendering layer (@linchkit/ui) are separated.
 * Supports four view types: list / form / kanban / dashboard.
 */

// ── View types ───────────────────────────────────────

export type ViewType = "list" | "form" | "kanban" | "dashboard" | "workspace";

// ── View field configuration ───────────────────────────────────

export interface ViewFieldConfig {
  field: string;
  label?: string;
  visible?: boolean;
  readonly?: boolean;
  width?: number | string;
  sortable?: boolean;
  filterable?: boolean;
  component?: string;
}

// ── View Action buttons ────────────────────────────────

export interface ViewAction {
  action: string;
  label?: string;
  icon?: string;
  position?: "toolbar" | "row" | "form-header";
  confirm?: string;
  variant?: "default" | "destructive" | "outline" | "ghost";
}

// ── View definition ───────────────────────────────────────

export interface ViewDefinition {
  name: string;
  schema: string;
  type: ViewType;
  label?: string;
  description?: string;

  fields: ViewFieldConfig[];
  actions?: ViewAction[];

  // List-specific
  defaultSort?: { field: string; order: "asc" | "desc" };
  defaultFilter?: Record<string, unknown>;
  pageSize?: number;

  // Kanban-specific
  groupBy?: string;

  // Form-specific
  layout?: FormLayout;
}

// ── Form layout ──────────────────────────────────────

export interface FormLayout {
  sections: FormSection[];
}

export interface FormSection {
  title?: string;
  columns?: number;
  fields: string[];
}

// ── View extension (for Bridge / tenant override) ──────────────────

export interface ViewExtension {
  addFields?: ViewFieldConfig[];
  removeFields?: string[];
  addActions?: ViewAction[];
  removeActions?: string[];
  overrideFields?: Record<string, Partial<ViewFieldConfig>>;
}
