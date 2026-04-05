# Capability Extraction Plan

> **Principle:** Core provides only engines + types + pipeline. ALL concrete implementations are Capabilities.
> The adapter capabilities (`cap-adapter-server`, `cap-adapter-ui`) should ONLY handle protocol adaptation.

## 1. Audit Results

### 1.1 cap-adapter-server violations

| File | Feature | Classification | Rationale |
|------|---------|---------------|-----------|
| `proposal-api.ts` | AI Proposal/Evolution/Insight REST endpoints | **EXTRACT** | Business feature (AI-driven schema evolution), not transport concern |
| `ai/system-prompt.ts` | AI chat system prompt builder | **EXTRACT** | AI assistant business logic |
| `ai/tools.ts` | AI chat tool definitions (Vercel AI SDK) | **EXTRACT** | AI assistant business logic |
| `routes/ai-api.ts` | AI auto-fill, chat, intent resolution, search endpoints | **EXTRACT** | AI-powered features, not transport concern |
| `routes/approval-api.ts` | Approval CRUD + approve/reject endpoints | **EXTRACT** | Business workflow feature |
| `routes/admin-api.ts` — rules/flows/states/executions | Rule/Flow/State listing, Execution log query | **EXTRACT** | Admin/DevOps introspection feature |
| `routes/admin-api.ts` — health/metrics/app-config/tenants/settings | Health check, metrics, app-config, tenants, settings | **KEEP** | Server infrastructure concern — health/metrics belong in the HTTP adapter |
| `subscription-manager.ts` | SSE connection management, event dispatch, heartbeat | **KEEP** | Transport-level concern — SSE is a transport protocol. The *manager* bridges EventBus to SSE streams. |
| `routes/subscription-api.ts` | SSE endpoint mounting | **KEEP** | HTTP route for SSE transport |
| `routes/import-api.ts` | Bulk data import (JSON/CSV) | **EXTRACT** | Data management feature, not transport |
| `default-views.ts` | Auto-generate list/form views for schemas | **MOVE_TO_CORE** | View generation is a core concern (OntologyRegistry / ViewRegistry should provide defaults) |
| `graphql/` (all files) | GraphQL schema building, CRUD, links, subscriptions | **KEEP** | Core transport protocol implementation |
| `routes/schema-api.ts` | Schema metadata REST endpoint | **KEEP** | Core REST transport for schema discovery |
| `routes/action-api.ts` | Action execution REST endpoint | **KEEP** | Core REST transport for action dispatch |

### 1.2 cap-adapter-ui violations

| File | Feature | Classification | Rationale |
|------|---------|---------------|-----------|
| `components/ai-assistant.tsx` | AI chat side panel (useChat, Vercel AI SDK) | **EXTRACT** | AI assistant UI, not core rendering framework |
| `components/ai-insights-panel.tsx` | Dashboard panel showing AI-detected patterns | **EXTRACT** | AI evolution UI |
| `components/ai-suggestion-badge.tsx` | Inline AI suggestion accept/reject overlay | **EXTRACT** | AI auto-fill UI |
| `components/action-proposal-card.tsx` | AI intent resolution confirmation card | **EXTRACT** | AI assistant UI |
| `hooks/use-ai-auto-fill.ts` | AI auto-fill hook | **EXTRACT** | AI feature hook |
| `hooks/use-ai-search.ts` | AI natural language search hook | **EXTRACT** | AI feature hook |
| `pages/proposals.tsx` | AI proposals listing page | **EXTRACT** | AI evolution UI |
| `pages/evolution.tsx` | AI evolution history page | **EXTRACT** | AI evolution UI |
| `pages/approvals.tsx` | Approval inbox page | **EXTRACT** | Approval workflow UI |
| `pages/flows.tsx` | Flow listing admin page | **EXTRACT** | Admin UI |
| `pages/flow-detail.tsx` | Flow detail page | **EXTRACT** | Admin UI |
| `pages/rules-list.tsx` | Rule listing admin page | **EXTRACT** | Admin UI |
| `pages/rule-detail.tsx` | Rule detail page | **EXTRACT** | Admin UI |
| `pages/state-machines.tsx` | State machine listing page | **EXTRACT** | Admin UI |
| `pages/execution-logs.tsx` | Execution log dashboard | **EXTRACT** | Admin UI |
| `pages/health-monitor.tsx` | Health monitor dashboard | **EXTRACT** | Admin/DevOps UI |
| `pages/settings.tsx` | System settings page | **EXTRACT** | Admin UI |
| `components/notification-center.tsx` | Bell icon + notification popover | **EXTRACT** | Notification is a cross-cutting feature |
| `hooks/use-notifications.ts` | Notification state management | **EXTRACT** | Notification feature |
| `components/flow-diagram.tsx` | ReactFlow-based flow visualization | **EXTRACT** | Admin flow visualization |
| `components/state-diagram.tsx` | ReactFlow-based state machine visualization | **EXTRACT** | Admin state visualization |
| `components/auto-kanban/` | Kanban board view | **KEEP** | Core view type — the React adapter should provide standard view renderers |
| `components/auto-tree/` | Tree view | **KEEP** | Core view type — hierarchical display is a standard view type |
| `components/auto-calendar/` | Calendar view | **KEEP** | Core view type |
| `components/auto-list/` | List view | **KEEP** | Core view type |
| `components/auto-form/` | Form view | **KEEP** | Core view type |
| `components/one2many-field.tsx` | One2many inline table widget | **KEEP** | Core relational field widget — part of the rendering framework |
| `components/widgets/rich-text-widget.tsx` | Tiptap rich text editor | **KEEP** | Core field widget — standard field type renderer |
| `components/widgets/*.tsx` (other) | All standard field type widgets | **KEEP** | Core field type rendering |
| `hooks/use-subscription.ts` | SSE subscription hook | **KEEP** | Transport-level React hook |
| `hooks/use-auth.tsx` | Auth state hook | **KEEP** | Adapter-level auth integration |
| `pages/dashboard.tsx` | Main dashboard | **KEEP** | Core UI shell |
| `pages/workspace.tsx` | Workspace page | **KEEP** | Core UI shell |
| `pages/schema-list.tsx` | Schema list view page | **KEEP** | Core data display |
| `pages/schema-form.tsx` | Schema form view page | **KEEP** | Core data display |
| `capability-page-registry.tsx` | Capability page resolution | **KEEP** | Core UI extension mechanism |

---

## 2. Extraction Plan

### 2.1 `@linchkit/cap-ai` — AI Assistant & Intelligence

**Scope:** All AI-powered features — chat assistant, auto-fill, intent resolution, NL search.

**Server-side files to extract from `cap-adapter-server`:**

| Source | Destination |
|--------|-------------|
| `routes/ai-api.ts` | `cap-ai/src/server/ai-api.ts` |
| `ai/system-prompt.ts` | `cap-ai/src/server/system-prompt.ts` |
| `ai/tools.ts` | `cap-ai/src/server/tools.ts` |

**UI-side files to extract from `cap-adapter-ui`:**

| Source | Destination |
|--------|-------------|
| `components/ai-assistant.tsx` | `cap-ai/src/ui/ai-assistant.tsx` |
| `components/ai-suggestion-badge.tsx` | `cap-ai/src/ui/ai-suggestion-badge.tsx` |
| `components/action-proposal-card.tsx` | `cap-ai/src/ui/action-proposal-card.tsx` |
| `hooks/use-ai-auto-fill.ts` | `cap-ai/src/ui/hooks/use-ai-auto-fill.ts` |
| `hooks/use-ai-search.ts` | `cap-ai/src/ui/hooks/use-ai-search.ts` |

**Capability definition:**

```typescript
defineCapability({
  name: "cap-ai",
  label: "AI Assistant",
  type: "standard",
  category: "intelligence",
  version: "0.0.1",
  extensions: {
    // Register REST routes via hooks
    hooks: {
      "server:routes": (app, options) => mountAIRoutes(app, options),
    },
    // Register UI components for the adapter to render
    services: {
      "ai:assistant-panel": AIAssistant,
      "ai:auto-fill-hook": useAiAutoFill,
      "ai:search-hook": useAiSearch,
    },
  },
});
```

**Dependencies:** `@linchkit/core` (AIService, SchemaRegistry, CommandLayer, OntologyRegistry), `ai` (Vercel AI SDK), `@ai-sdk/react`, `zod`

---

### 2.2 `@linchkit/cap-ai-evolution` — AI Evolution & Proposals

**Scope:** AI-driven schema evolution — proposals, pattern detection, insights, evolution history.

**Server-side files to extract from `cap-adapter-server`:**

| Source | Destination |
|--------|-------------|
| `proposal-api.ts` | `cap-ai-evolution/src/server/proposal-api.ts` |

**UI-side files to extract from `cap-adapter-ui`:**

| Source | Destination |
|--------|-------------|
| `pages/proposals.tsx` | `cap-ai-evolution/src/ui/pages/proposals.tsx` |
| `pages/evolution.tsx` | `cap-ai-evolution/src/ui/pages/evolution.tsx` |
| `components/ai-insights-panel.tsx` | `cap-ai-evolution/src/ui/ai-insights-panel.tsx` |

**Capability definition:**

```typescript
defineCapability({
  name: "cap-ai-evolution",
  label: "AI Evolution",
  type: "standard",
  category: "intelligence",
  version: "0.0.1",
  pages: [
    { path: "/admin/proposals", component: "ai-evolution:proposals", label: "AI Proposals", group: "admin" },
    { path: "/admin/evolution", component: "ai-evolution:history", label: "Evolution History", group: "admin" },
  ],
  extensions: {
    hooks: {
      "server:routes": (app, options) => mountProposalAPI(app, options.executionLogger),
    },
    services: {
      "ai-evolution:insights-panel": AIInsightsPanel,
    },
  },
});
```

**Dependencies:** `@linchkit/core` (ProposalEngine, PatternDetector, ExecutionLogger)

---

### 2.3 `@linchkit/cap-approval` — Approval Workflow

**Scope:** Approval request management — inbox, approve/reject actions, pending count badge.

**Server-side files to extract from `cap-adapter-server`:**

| Source | Destination |
|--------|-------------|
| `routes/approval-api.ts` | `cap-approval/src/server/approval-api.ts` |

**UI-side files to extract from `cap-adapter-ui`:**

| Source | Destination |
|--------|-------------|
| `pages/approvals.tsx` | `cap-approval/src/ui/pages/approvals.tsx` |

**Capability definition:**

```typescript
defineCapability({
  name: "cap-approval",
  label: "Approval Workflow",
  type: "standard",
  category: "workflow",
  version: "0.0.1",
  pages: [
    { path: "/admin/approvals", component: "approval:inbox", label: "Approvals", group: "admin" },
  ],
  extensions: {
    hooks: {
      "server:routes": (app, options) => mountApprovalRoutes(app, options),
    },
  },
});
```

**Dependencies:** `@linchkit/core` (ApprovalEngine, ApprovalStore)

**Note:** The `ApprovalEngine` itself already lives in `@linchkit/core`. This capability only wraps the REST transport + UI.

---

### 2.4 `@linchkit/cap-admin` — Admin Dashboard

**Scope:** System introspection UI — rules, flows, state machines, execution logs, health monitor, settings.

**Server-side files to extract from `cap-adapter-server`:**

| Source | Destination |
|--------|-------------|
| `routes/admin-api.ts` — rules/flows/states/executions endpoints only | `cap-admin/src/server/admin-api.ts` |

**Retained in `cap-adapter-server`:** `/health`, `/api/metrics`, `/api/app-config`, `/api/tenants`, `/api/settings` (server infrastructure).

**UI-side files to extract from `cap-adapter-ui`:**

| Source | Destination |
|--------|-------------|
| `pages/flows.tsx` | `cap-admin/src/ui/pages/flows.tsx` |
| `pages/flow-detail.tsx` | `cap-admin/src/ui/pages/flow-detail.tsx` |
| `pages/rules-list.tsx` | `cap-admin/src/ui/pages/rules-list.tsx` |
| `pages/rule-detail.tsx` | `cap-admin/src/ui/pages/rule-detail.tsx` |
| `pages/state-machines.tsx` | `cap-admin/src/ui/pages/state-machines.tsx` |
| `pages/execution-logs.tsx` | `cap-admin/src/ui/pages/execution-logs.tsx` |
| `pages/health-monitor.tsx` | `cap-admin/src/ui/pages/health-monitor.tsx` |
| `pages/settings.tsx` | `cap-admin/src/ui/pages/settings.tsx` |
| `components/flow-diagram.tsx` | `cap-admin/src/ui/components/flow-diagram.tsx` |
| `components/state-diagram.tsx` | `cap-admin/src/ui/components/state-diagram.tsx` |

**Capability definition:**

```typescript
defineCapability({
  name: "cap-admin",
  label: "Admin Dashboard",
  type: "standard",
  category: "admin",
  version: "0.0.1",
  pages: [
    { path: "/admin/rules", component: "admin:rules", label: "Rules", group: "admin" },
    { path: "/admin/rules/:name", component: "admin:rule-detail", label: "Rule Detail", group: "admin" },
    { path: "/admin/flows", component: "admin:flows", label: "Flows", group: "admin" },
    { path: "/admin/flows/:name", component: "admin:flow-detail", label: "Flow Detail", group: "admin" },
    { path: "/admin/states", component: "admin:states", label: "State Machines", group: "admin" },
    { path: "/admin/executions", component: "admin:executions", label: "Execution Logs", group: "admin" },
    { path: "/admin/health", component: "admin:health", label: "Health Monitor", group: "admin" },
    { path: "/admin/settings", component: "admin:settings", label: "Settings", group: "admin" },
  ],
  extensions: {
    hooks: {
      "server:routes": (app, options) => mountAdminMetadataRoutes(app, options),
    },
  },
});
```

**Dependencies:** `@linchkit/core` (RuleDefinition, FlowDefinition, StateDefinition, ExecutionLogger), `@xyflow/react`, `dagre` (for diagrams)

---

### 2.5 `@linchkit/cap-notification` — Notification System

**Scope:** Real-time notification bell, notification popover, notification state management.

**UI-side files to extract from `cap-adapter-ui`:**

| Source | Destination |
|--------|-------------|
| `components/notification-center.tsx` | `cap-notification/src/ui/notification-center.tsx` |
| `hooks/use-notifications.ts` | `cap-notification/src/ui/hooks/use-notifications.ts` |

**Capability definition:**

```typescript
defineCapability({
  name: "cap-notification",
  label: "Notifications",
  type: "standard",
  category: "ux",
  version: "0.0.1",
  extensions: {
    services: {
      "notification:center": NotificationCenter,
      "notification:hook": useNotifications,
    },
  },
});
```

**Dependencies:** `@linchkit/core` (EventBus subscription types), SSE hook from `cap-adapter-ui`

**Note:** This is purely a UI capability — it consumes SSE events from the transport layer (which stays in `cap-adapter-server`).

---

### 2.6 `@linchkit/cap-import` — Data Import

**Scope:** Bulk data import from JSON/CSV files.

**Server-side files to extract from `cap-adapter-server`:**

| Source | Destination |
|--------|-------------|
| `routes/import-api.ts` | `cap-import/src/server/import-api.ts` |

**UI-side files to extract from `cap-adapter-ui`:**

| Source | Destination |
|--------|-------------|
| `components/auto-list/import-dialog.tsx` | `cap-import/src/ui/import-dialog.tsx` |

**Capability definition:**

```typescript
defineCapability({
  name: "cap-import",
  label: "Data Import",
  type: "standard",
  category: "data",
  version: "0.0.1",
  extensions: {
    hooks: {
      "server:routes": (app, options) => mountImportRoutes(app, options),
    },
    services: {
      "import:dialog": ImportDialog,
    },
  },
});
```

**Dependencies:** `@linchkit/core` (CommandLayer, SchemaRegistry)

---

### 2.7 `default-views.ts` — Move to Core

**Scope:** Auto-generation of default list/form views from `SchemaDefinition`.

**Action:** Move `cap-adapter-server/src/default-views.ts` to `packages/core/src/view/default-views.ts`.

This logic belongs in the ViewRegistry or OntologyRegistry — the core should be able to generate sensible defaults for any schema, not just when the HTTP adapter is present.

**No new capability needed** — this is a core engine concern.

---

## 3. Extension Mechanism Requirements

The current `extensions` contract supports: `transports`, `commands`, `fieldTypes`, `viewTypes`, `ruleEffects`, `services`, `hooks`, `middlewares`.

For this plan to work, the following extension points need to be formalized:

1. **`hooks["server:routes"]`** — Allow capabilities to register REST routes on the Elysia app. The HTTP adapter calls all registered route hooks during server setup.

2. **`services` with well-known keys** — UI adapter resolves components/hooks by service key. For example, `cap-ai` registers `"ai:assistant-panel"` and the UI adapter's layout checks if this service exists before rendering the AI button.

3. **`pages`** — Already supported via `CapabilityDefinition.pages`. The UI adapter's `capability-page-registry.tsx` already resolves pages dynamically.

---

## 4. Migration Strategy

### Phase 1: Core preparation
1. Move `default-views.ts` into `@linchkit/core`
2. Formalize the `hooks["server:routes"]` extension point in the adapter
3. Formalize the UI service resolution pattern

### Phase 2: Extract capabilities (one at a time, keep tests green)
1. `cap-admin` — Largest extraction, low coupling risk (read-only pages)
2. `cap-approval` — Small, self-contained
3. `cap-notification` — Small, UI-only
4. `cap-import` — Small, self-contained
5. `cap-ai` — Medium, depends on AI SDK wiring
6. `cap-ai-evolution` — Small, depends on `cap-ai`

### Phase 3: Adapter cleanup
1. Remove extracted files from `cap-adapter-server` and `cap-adapter-ui`
2. Update the adapters to discover and wire capabilities via extension points
3. Verify all tests pass after each extraction

---

## 5. Impact Summary

| Metric | Before | After |
|--------|--------|-------|
| Files in `cap-adapter-server/src/` | 15+ | ~8 (transport-only) |
| Files in `cap-adapter-ui/src/` | 40+ pages/components | ~25 (core views + shell) |
| New capabilities | 0 | 6 (`cap-ai`, `cap-ai-evolution`, `cap-approval`, `cap-admin`, `cap-notification`, `cap-import`) |
| Files moved to core | 0 | 1 (`default-views.ts`) |

### What remains in `cap-adapter-server` after extraction:
- `server.ts` — Elysia app setup, CORS, body parsing
- `capability.ts` — Transport registration
- `graphql/` — GraphQL schema building, CRUD, links, subscriptions
- `routes/schema-api.ts` — Schema metadata REST
- `routes/action-api.ts` — Action execution REST
- `routes/subscription-api.ts` — SSE transport endpoint
- `routes/shared.ts` — Shared utilities (actor resolution, locale)
- `subscription-manager.ts` — SSE connection management
- `routes/admin-api.ts` — Only `/health`, `/api/metrics`, `/api/app-config`, `/api/tenants`, `/api/settings`
- `config-loader.ts` — Config loading

### What remains in `cap-adapter-ui` after extraction:
- Core shell: `app.tsx`, `main.tsx`, layouts, sidebar, header
- Core views: `auto-list/`, `auto-form/`, `auto-kanban/`, `auto-tree/`, `auto-calendar/`
- Core widgets: `widgets/` (all field type renderers)
- Core pages: `dashboard.tsx`, `workspace.tsx`, `schema-list.tsx`, `schema-form.tsx`
- Core hooks: `use-schemas.tsx`, `use-schema-bundle.tsx`, `use-subscription.ts`, `use-auth.tsx`
- Core components: `command-palette.tsx`, `field-renderer.tsx`, `one2many-field.tsx`, `related-records-panel.tsx`, `tenant-switcher.tsx`
- Extension infra: `capability-page-registry.tsx`, `capability-styles.css`
