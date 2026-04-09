# Spec 54 — Advanced UI Features

> This spec extends [Spec 13 — View & UI](./13_view_and_ui.md). Read that spec first for context.
> Spec 13 defines the view system, view types (`list`, `form`, `detail`, `kanban`, `dashboard`, `calendar`, `tree`), layout priority chain, Widget Registry, SearchBar architecture, and AI-native design principles. This spec does NOT redefine those concepts. Instead, it adds:
> - **Field dependencies** (show/hide) — new `visibleWhen` property for conditional form rendering
> - **Saved filters / custom views** — persistent named filter presets
> - **Tree view enhancements** — inline actions, DnD, hybrid view (extending the `tree` type from spec 13 §6)
> - **Dashboard builder** — user-customizable widget layout (extending the `dashboard` type from spec 13 §4.4)
> - **Rich text editor** — Tiptap-based editor (implementing the `rich_text` field type referenced in spec 13 §7)
> - **Print / PDF export** — client-side print CSS
> - **Record templates** — pre-filled field value presets
> Also references: [Spec 14 — System Capabilities](./14_system_capabilities.md) §4.9 (`cap-dashboard`), [Spec 03 — Schema](./03_schema.md), [Spec 46 — Link Type](./46_link_type.md)

> **Status:** Draft
> **Milestone:** M3
> **Dependencies:** Spec 13 (View & UI), Spec 03 (Schema), Spec 46 (Link Type)
>
> Tracking milestones:
> - `M5: Platform Maturity & AI Evolution`
>
> Related issues:
> - GitHub Issue `#86` — Advanced UI features
>
> Execution source of truth: GitHub milestones and issues.

## Overview

This spec defines advanced UI features that build on top of the existing view system ([Spec 13](./13_view_and_ui.md)) and schema-driven rendering in `cap-adapter-ui`. These features enhance form interactivity, list flexibility, data visualization, and content editing without changing the core meta-model.

All features follow the existing architecture principle: **declarations live in `@linchkit/core` types, rendering lives in `cap-adapter-ui`**.

---

## 1. Field Dependencies (Show/Hide)

### Problem

Forms currently render all visible fields unconditionally. Real-world forms often need conditional visibility — e.g., show "urgent reason" only when priority is "high", show "rejection reason" only when decision is "reject".

### Design

Add a `visibleWhen` property to `ViewFieldConfig` and `FormFieldNode`. The condition references another field's value using the existing `ComparisonOperator` type.

#### Type Additions

```typescript
// packages/core/src/types/view.ts

/** Condition for dynamic field visibility */
export interface FieldVisibilityCondition {
  /** Name of the field to watch */
  field: string;
  /** Comparison operator (reuses DeclarativeCondition operators) */
  operator: "eq" | "neq" | "in" | "not_in" | "gt" | "gte" | "lt" | "lte" | "contains";
  /** Value(s) to compare against */
  value: unknown;
}

export interface ViewFieldConfig {
  // ... existing fields ...
  /** When set, field is only visible if the condition is met */
  visibleWhen?: FieldVisibilityCondition;
}

export interface FormFieldNode {
  // ... existing fields ...
  /** When set, field is only visible if the condition is met */
  visibleWhen?: FieldVisibilityCondition;
}
```

#### Usage Example

```typescript
defineView({
  name: "ticket-form",
  schema: "support_ticket",
  type: "form",
  fields: [
    { field: "priority" },
    { field: "urgent_reason", visibleWhen: { field: "priority", operator: "eq", value: "high" } },
    { field: "category" },
    { field: "escalation_team", visibleWhen: { field: "category", operator: "in", value: ["security", "outage"] } },
  ],
});
```

#### Rendering Behavior

- **AutoForm** watches form state via `react-hook-form`'s `watch()`. When the watched field changes, dependent fields show/hide with a CSS transition (no layout jump).
- Hidden fields are **not rendered** in the DOM (unmounted), so their validators do not fire.
- Hidden fields are **excluded from submission data** — the form strips them before `onSubmit`.
- Nested dependencies are supported (field C depends on field B which depends on field A). Evaluation is reactive — a chain of changes propagates automatically.
- In `mode: "view"` (read-only), fields whose condition is not met are simply omitted from display.

#### FormGroup-Level Conditions

Groups and notebook pages can also have `visibleWhen`, hiding entire sections:

```typescript
{
  type: "group",
  title: "Advanced Options",
  visibleWhen: { field: "mode", operator: "eq", value: "advanced" },
  children: [
    { type: "field", field: "retry_count" },
    { type: "field", field: "timeout_ms" },
  ],
}
```

Add `visibleWhen?: FieldVisibilityCondition` to `FormGroupNode`, `FormPageNode`, and `FormNotebookNode`.

---

## 2. Saved Filters / Custom Views

### Problem

Users frequently apply the same filter + sort + column configurations. Currently, filters are ephemeral — lost on navigation. Power users need named, reusable filter presets.

### Design

#### Data Model

System table `_linchkit_saved_views` stores per-user saved configurations:

```typescript
// packages/core/src/persistence/system-tables.ts

export const savedViewsTable = pgTable("_linchkit_saved_views", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Schema this saved view applies to */
  schema_name: varchar("schema_name", { length: 255 }).notNull(),
  /** Display name, e.g. "My pending requests" */
  name: varchar("name", { length: 255 }).notNull(),
  /** User who created this saved view */
  user_id: varchar("user_id", { length: 255 }).notNull(),
  /** Tenant scope */
  tenant_id: varchar("tenant_id", { length: 255 }),
  /** Serialized filter conditions (DeclarativeCondition[]) */
  filters: jsonb("filters").notNull().default([]),
  /** Sort configuration */
  sort: jsonb("sort"),  // { field: string; order: "asc" | "desc" }
  /** Visible column list (field names). null = default columns */
  columns: jsonb("columns"),  // string[] | null
  /** Page size override */
  page_size: integer("page_size"),
  /** Whether this view is shared with the team (visible to all users in tenant) */
  is_shared: boolean("is_shared").notNull().default(false),
  /** Display order for the user's saved view tabs */
  sort_order: integer("sort_order").notNull().default(0),
  /** Soft delete */
  is_deleted: boolean("is_deleted").notNull().default(false),
  created_at: timestamp("created_at").notNull().defaultNow(),
  updated_at: timestamp("updated_at").notNull().defaultNow(),
});
```

#### GraphQL API

```graphql
type SavedView {
  id: ID!
  schemaName: String!
  name: String!
  userId: String!
  filters: JSON!
  sort: JSON
  columns: [String!]
  pageSize: Int
  isShared: Boolean!
  createdAt: DateTime!
}

type Query {
  savedViews(schemaName: String!): [SavedView!]!
}

type Mutation {
  createSavedView(input: CreateSavedViewInput!): SavedView!
  updateSavedView(id: ID!, input: UpdateSavedViewInput!): SavedView!
  deleteSavedView(id: ID!): Boolean!
}
```

#### UI Behavior

- **Save button**: When filters are active, a "Save as view" button appears in `ListToolbar`. Opens a dialog to name the view.
- **View tabs**: Saved views render as horizontal tabs above the list (similar to Odoo's "Favorites"). Clicking a tab applies its filters/sort/columns.
- **"All" tab**: Always present as the first tab — shows unfiltered default view.
- **Shared views**: Views marked `is_shared` appear for all users in the same tenant. Only the creator can edit/delete shared views.
- **Edit/Delete**: Right-click or dropdown menu on a tab allows rename, update (overwrite current filters), toggle sharing, or delete.
- **URL sync**: Active saved view ID is reflected in URL query param (`?view=<id>`) so views are shareable via link.

---

## 3. Tree View Enhancements

> The `tree` view type is defined in [Spec 13](./13_view_and_ui.md) §6 (milestone M2). An `AutoTree` component already exists in `cap-adapter-ui`. This section defines enhancements to that existing implementation.

### Current State

An `AutoTree` component already exists (`capabilities/cap-adapter-ui/src/components/auto-tree/`). It supports:

- `parentField` for self-referencing hierarchy
- `labelField` for node display
- Expand/collapse all, individual node toggle
- Folder/file icons, child count display

### Enhancements

The following enhancements build on the existing implementation:

#### 3.1 Inline Actions on Tree Nodes

Add context menu (right-click) or action buttons on hover for tree nodes:

```typescript
export interface AutoTreeProps {
  // ... existing props ...
  /** Actions available on each tree node */
  nodeActions?: TreeNodeAction[];
}

export interface TreeNodeAction {
  action: string;
  label: string;
  icon?: string;
  /** Only show for nodes matching this condition */
  visibleWhen?: (record: Record<string, unknown>) => boolean;
}
```

Use cases: "Add child", "Move", "Delete" on tree nodes.

#### 3.2 Drag-and-Drop Reparenting

Allow dragging nodes to change their parent. Uses `@dnd-kit/core` (already a common React DnD library):

- Visual drop indicators (above, below, as-child)
- Server-side update via existing CRUD action (`update` with new `parent_id`)
- Optimistic UI with rollback on failure

#### 3.3 Tree + List Hybrid

Split view: tree on the left, list of selected node's children on the right. Useful for category browsing — select a category in the tree, see its items in a list.

```typescript
defineView({
  name: "category-browser",
  schema: "category",
  type: "tree",
  parentField: "parent_id",
  labelField: "name",
  /** When set, clicking a tree node shows a filtered list of this schema */
  childListSchema: "product",
  /** The field on childListSchema that references this tree's records */
  childListForeignKey: "category_id",
});
```

#### 3.4 Search/Filter Within Tree

Filter tree nodes by text search. Non-matching branches are hidden; matching nodes and their ancestor chain remain visible (to preserve tree context).

---

## 4. Dashboard Builder

> The `dashboard` view type is defined in [Spec 13](./13_view_and_ui.md) §4.4 with a basic `widgets` array (stat, chart, list). [Spec 14](./14_system_capabilities.md) §4.9 defines `@linchkit/cap-dashboard` as a system capability providing a drag-and-drop dashboard builder. This section provides the detailed design for that capability's data model, widget types, and layout engine.

### Problem

The workspace page (`/`) is currently static. Users need a customizable dashboard with widgets showing key metrics, recent activity, and saved filter shortcuts.

### Design

#### Data Model

```typescript
// packages/core/src/persistence/system-tables.ts

export const dashboardConfigTable = pgTable("_linchkit_dashboard_configs", {
  id: uuid("id").primaryKey().defaultRandom(),
  user_id: varchar("user_id", { length: 255 }).notNull(),
  tenant_id: varchar("tenant_id", { length: 255 }),
  /** Dashboard name. Default: "My Dashboard" */
  name: varchar("name", { length: 255 }).notNull().default("My Dashboard"),
  /** Widget layout configuration */
  layout: jsonb("layout").notNull().default([]),
  /** Whether this is the user's default dashboard */
  is_default: boolean("is_default").notNull().default(true),
  created_at: timestamp("created_at").notNull().defaultNow(),
  updated_at: timestamp("updated_at").notNull().defaultNow(),
});
```

#### Widget Types

```typescript
export type DashboardWidgetType =
  | "stat_card"       // Single KPI value with trend
  | "chart"           // Bar, line, pie chart
  | "recent_activity" // Latest execution log entries
  | "saved_views"     // Quick links to saved filter views
  | "record_list"     // Inline mini-list of a schema with filters
  | "markdown"        // Free-form text/notes widget
  ;

export interface DashboardWidget {
  id: string;
  type: DashboardWidgetType;
  /** Grid position and size (CSS Grid based) */
  position: { x: number; y: number; w: number; h: number };
  /** Widget-specific configuration */
  config: Record<string, unknown>;
}

// stat_card config example:
// { schema: "purchase_order", aggregation: "count", filter: { status: "pending" }, label: "Pending POs" }

// chart config example:
// { schema: "purchase_order", type: "bar", groupBy: "status", metric: "count" }
```

#### Layout Engine

- Grid-based layout using CSS Grid (12-column grid, similar to Grafana)
- Drag-and-drop widget placement and resizing via `react-grid-layout`
- Edit mode toggle: "Customize" button switches to edit mode where widgets can be moved/resized/removed
- Widget picker: "Add widget" opens a panel with available widget types

#### Rendering

- Each widget type maps to a React component registered in a `DashboardWidgetRegistry`
- Widgets fetch their own data via GraphQL queries derived from their config
- Auto-refresh interval configurable per widget (default: 60s for stat cards, no auto-refresh for static widgets)

---

## 5. Rich Text Editor

> [Spec 13](./13_view_and_ui.md) §7 (layout override chain) references `rich_text` as a field type that can be applied via tenant overrides or bridges. This section provides the detailed implementation design for that field type.

### Problem

The `text` field type currently renders as a plain `<textarea>`. Many use cases (descriptions, notes, documentation) need rich formatting.

### Design

#### Field Configuration

```typescript
// In FieldUIHints (packages/core/src/types/schema.ts)
export interface FieldUIHints {
  // ... existing fields ...
  /** Editor type for text fields. "plain" = textarea (default), "rich" = rich text editor */
  editor?: "plain" | "rich";
  /** Storage format for rich text. "html" (default) or "markdown" */
  editorFormat?: "html" | "markdown";
}
```

#### Usage

```typescript
defineEntity({
  name: "article",
  fields: {
    title: { type: "string", required: true },
    body: {
      type: "text",
      ui: { editor: "rich", editorFormat: "html" },
    },
    internal_notes: {
      type: "text",
      ui: { editor: "rich", editorFormat: "markdown" },
    },
  },
});
```

#### Editor Choice

Use **Tiptap** (`@tiptap/react`) — lightweight, extensible, built on ProseMirror:

- **Starter Kit**: bold, italic, strike, headings (H1-H3), bullet/ordered lists, blockquote, code block, horizontal rule
- **Extensions**: link, image (URL only — no upload in v1), table, task list
- **Toolbar**: Floating bubble menu on text selection + fixed toolbar above editor
- **Read-only mode**: Renders HTML content without editor chrome (for `mode: "view"`)

#### Widget Registration

Register as a new widget `text-rich` in the widget registry:

```typescript
widgetRegistry.register({
  id: "text-rich",
  fieldTypes: "text",
  modes: ["display", "input"],
  supportedFormats: [],
});
```

Auto-resolved when `ui.editor === "rich"`. The display widget renders sanitized HTML; the input widget renders the Tiptap editor.

#### Storage

- **HTML format**: Stored as sanitized HTML string in a `text` column. Sanitization via `DOMPurify` on both client and server.
- **Markdown format**: Stored as Markdown string. Rendered to HTML via `marked` for display. Editor uses Tiptap with Markdown serialization.

---

## 6. Print / PDF Export

### Problem

Users need to print form records (invoices, purchase orders, reports) with clean formatting.

### Design

#### Client-Side Print

**P2 — minimal implementation:**

- "Print" button on form page header (alongside Edit/Delete actions)
- Opens browser print dialog (`window.print()`)
- Print-specific CSS via `@media print`:
  - Hide sidebar, header, footer, action buttons
  - Clean typography, proper page breaks
  - Form fields render as labeled values (no input borders)
  - Respect `@page` margin/size settings
- Print CSS lives in `capabilities/cap-adapter-ui/src/styles/print.css`

#### Print Layout Configuration

Optional per-schema print layout:

```typescript
defineView({
  name: "invoice-print",
  schema: "invoice",
  type: "form",
  label: "Invoice Print Layout",
  // When a view with name "{schema}-print" exists, the Print button uses it
  layout: {
    nodes: [
      { type: "group", title: "Invoice Details", children: [
        { type: "field", field: "invoice_number" },
        { type: "field", field: "date" },
        { type: "field", field: "customer_name" },
      ]},
      // ... line items, totals, etc.
    ],
  },
});
```

#### Server-Side PDF (Future — P3)

- Endpoint: `GET /api/schemas/:name/:id/pdf`
- Uses Puppeteer or `@react-pdf/renderer` to generate PDF from the print view
- Returns `Content-Type: application/pdf`
- Not in initial implementation scope

---

## 7. Record Templates

### Problem

Users creating records often start from known patterns (e.g., "Standard IT purchase request", "Security incident report"). Pre-filling fields from templates saves time and enforces consistency.

### Design

#### Data Model

```typescript
// packages/core/src/persistence/system-tables.ts

export const recordTemplatesTable = pgTable("_linchkit_record_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  schema_name: varchar("schema_name", { length: 255 }).notNull(),
  /** Template name, e.g. "Standard IT Purchase" */
  name: varchar("name", { length: 255 }).notNull(),
  /** Template description */
  description: text("description"),
  /** Pre-filled field values (partial record data) */
  values: jsonb("values").notNull().default({}),
  /** Who created the template */
  created_by: varchar("created_by", { length: 255 }),
  /** Tenant scope */
  tenant_id: varchar("tenant_id", { length: 255 }),
  /** Whether this template is available to all users in tenant */
  is_shared: boolean("is_shared").notNull().default(true),
  /** Soft delete */
  is_deleted: boolean("is_deleted").notNull().default(false),
  /** Display order */
  sort_order: integer("sort_order").notNull().default(0),
  created_at: timestamp("created_at").notNull().defaultNow(),
  updated_at: timestamp("updated_at").notNull().defaultNow(),
});
```

#### UI Flow

1. **Create page**: When templates exist for a schema, the "New" button becomes a split button — click creates blank, dropdown shows template list.
2. **Template selection**: Selecting a template navigates to the create form with pre-filled values from `template.values`.
3. **"Save as template"**: On any filled form, a "Save as Template" action allows saving current field values as a new template.

#### URL Integration

Template pre-fill via URL: `/schemas/:name/new?template=<template_id>`

The create page loads template values and populates the form.

#### GraphQL API

```graphql
type RecordTemplate {
  id: ID!
  schemaName: String!
  name: String!
  description: String
  values: JSON!
  isShared: Boolean!
}

type Query {
  recordTemplates(schemaName: String!): [RecordTemplate!]!
}

type Mutation {
  createRecordTemplate(input: CreateRecordTemplateInput!): RecordTemplate!
  updateRecordTemplate(id: ID!, input: UpdateRecordTemplateInput!): RecordTemplate!
  deleteRecordTemplate(id: ID!): Boolean!
}
```

---

## 8. Implementation Priority

| Priority | Feature | Effort | Value | Notes |
|----------|---------|--------|-------|-------|
| **P1** | Field dependencies (show/hide) | S | High | Core form UX. Type change + AutoForm logic only. |
| **P1** | Saved filters / custom views | M | High | Needs system table + GraphQL + UI tabs. |
| **P2** | Rich text editor | S | Medium | Add Tiptap, register widget. Scoped to `text` fields. |
| **P2** | Print / PDF export | S | Medium | Client-side print CSS only in P2. |
| **P3** | Tree view enhancements | M | Medium | Base tree already exists. DnD and hybrid view are incremental. |
| **P3** | Dashboard builder | L | Medium | Largest feature. Grid layout + widget system + data fetching. |
| **P3** | Record templates | S | Low | Simple CRUD on templates table. Nice-to-have. |

**Effort scale:** S = < 1 week, M = 1-2 weeks, L = 3+ weeks.

### P1 Implementation Order

1. **Field dependencies**: Add `FieldVisibilityCondition` type to `@linchkit/core`. Update `AutoForm` to evaluate conditions via `watch()`. Update `FormField` to conditionally render. Strip hidden fields from submit data.

2. **Saved filters**: Add `_linchkit_saved_views` table. Add GraphQL CRUD. Build `SavedViewTabs` component in AutoList. Wire filter application on tab click. URL query param sync.

### Migration

All new system tables follow the existing pattern:
- Prefix: `_linchkit_`
- Schema: `_linchkit` PostgreSQL schema
- Managed via drizzle-kit `db:generate` + `db:migrate`
- `InMemoryStore` fallback for environments without PostgreSQL (saved views and templates stored in memory, lost on restart)

---

## 9. Non-Goals

- **Custom form builder / drag-drop form designer**: Forms are schema-driven. Layout customization happens via `FormLayout` nodes in code, not visual drag-drop.
- **File upload / attachment management**: Separate concern. Will be addressed in a dedicated storage capability.
- **Real-time collaborative editing**: Out of scope. Single-user editing with optimistic locking (`_version` field) is sufficient.
- **Chart library choice**: Dashboard builder spec defines the widget interface. Specific chart library (Recharts, Chart.js, etc.) is an implementation detail.

---

## 10. Related Specs

| Spec | Relationship |
|------|-------------|
| 13 — View & UI | Base view system this spec extends. Defines `dashboard` (§4.4), `tree` (§6), `rich_text` (§7) view/field types. This spec provides detailed implementation designs. |
| 14 — System Capabilities | §4.9 defines `cap-dashboard` capability. This spec provides its data model and layout engine. |
| 03 — Schema | Field types and `FieldUIHints` where `editor` config lives |
| 16 — Command Layer & API | GraphQL CRUD patterns for new system tables |
| 46 — Link Type | Tree view relates to self-referencing links |
| 44 — Realtime Subscription | Dashboard widgets can subscribe to real-time updates |
