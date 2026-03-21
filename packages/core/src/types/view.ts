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

// ── Form layout (Odoo-style group nesting) ──────────────────────────────────

/**
 * FormLayout is a tree of layout nodes.
 * Inspired by Odoo's <group>/<notebook>/<page> model:
 *
 * ```
 * { type: 'group', children: [
 *   { type: 'group', children: [
 *     { type: 'field', field: 'title' },
 *     { type: 'field', field: 'department' },
 *   ]},
 *   { type: 'group', children: [
 *     { type: 'field', field: 'status' },
 *     { type: 'field', field: 'priority' },
 *   ]},
 * ]}
 * ```
 */
export type FormLayoutNode =
  | FormFieldNode
  | FormGroupNode
  | FormNotebookNode
  | FormPageNode
  | FormSeparatorNode;

/** A single field in the form */
export interface FormFieldNode {
  type: "field";
  field: string;
  /** Override label from schema */
  label?: string;
  /** Force read-only */
  readonly?: boolean;
  /** Column span within parent group (1-based, default: 1) */
  colspan?: number;
  /** Custom component override */
  component?: string;
  /** Hide label */
  nolabel?: boolean;
  /** Additional CSS class */
  className?: string;
}

/** A group container — default 2 columns, nestable */
export interface FormGroupNode {
  type: "group";
  /** Optional group title (renders as a heading) */
  title?: string;
  /** Number of columns (default: 2) */
  columns?: number;
  /** Child nodes (fields, nested groups, separators) */
  children: FormLayoutNode[];
  /** Additional CSS class */
  className?: string;
}

/** Tab container — renders as tabs */
export interface FormNotebookNode {
  type: "notebook";
  children: FormPageNode[];
  /** Additional CSS class */
  className?: string;
}

/** A single tab page within a notebook */
export interface FormPageNode {
  type: "page";
  /** Tab label */
  title: string;
  children: FormLayoutNode[];
  /** Additional CSS class */
  className?: string;
}

/** Visual separator line with optional label */
export interface FormSeparatorNode {
  type: "separator";
  /** Optional label text */
  label?: string;
}

// ── Legacy FormLayout compat ─────────────────────────

export interface FormLayout {
  /** New: tree-based layout */
  nodes?: FormLayoutNode[];
  /** @deprecated Legacy flat sections — use nodes instead */
  sections?: FormSection[];
}

/** @deprecated Use FormGroupNode instead */
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
