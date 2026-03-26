# LinchKit - Development Instructions

## Overview

AI-Native Software Capability Runtime. **Milestone:** M2 — Link Type + OntologyRegistry + GraphQL Subscriptions.

Meta-model: **Schema + Action + Rule + State + Event + EventHandler + View + Flow + Link**

## Principles

- **KISS / YAGNI** — Don't build what you don't need
- **Data Structures First** — Design data structures before writing code
- **Communicate in Chinese** — Always use Chinese when talking to the user
- **Capability-Centric** — Everything is a Capability (business, system, protocol adapter). No "plugin" concept. See spec 01, 20.
- **Minimal Core** — Core provides only engines + types + pipeline. All concrete implementations (auth, MCP, permissions) are Capabilities.
- **Infinite Extensibility** — New protocols (MCP, A2A, AG-UI), field types, view types, services all register via Capability `extensions`. Core never changes.

## Tech Stack

| Layer | Stack |
|-------|-------|
| Runtime | Bun (not Node) |
| Language | TypeScript strict mode |
| Backend | Elysia |
| GraphQL | graphql-yoga + graphql-js (code-first, NOT Pothos) |
| ORM | Drizzle (PostgreSQL via drizzle-kit, InMemoryStore fallback) |
| Frontend | React 19 + Vite |
| Routing | TanStack Router |
| UI | Shadcn + Radix + Lucide + Tailwind |
| Table | TanStack Table |
| Form | Zod validation (from SchemaDefinition) |
| Command Palette | cmdk |
| i18n | react-i18next (en / zh-CN) |
| Code quality | Biome (no ESLint / Prettier) |
| Flow Engine | Restate (`@restatedev/restate-sdk` v1.11.1) — durable execution, dual-mode |
| Testing | bun test |

## Constraints (MUST follow)

- Use `bunx` never `npx`. E.g. `bunx shadcn@latest add ...`
- Registry mirror: `registry.npmmirror.com` (see `.bunfig.toml`)
- Comments and docs: **English**
- Function signatures: Use `{}` options object when > 3 parameters
- Pre-commit (lefthook): `biome check --staged` + `tsc --noEmit`
- Commit message: **Conventional Commits**
- drizzle-kit: Use `bun ./node_modules/.bin/drizzle-kit` (NOT `bunx drizzle-kit` — EPIPE bug on macOS)
- Database DDL: **Never hand-write CREATE TABLE / ALTER TABLE** — always delegate to drizzle-kit

## Packages

```
packages/ (core infrastructure):
  @linchkit/core       — Types, engines, pipeline — ✅
  @linchkit/cli        — CLI launcher (citty) — ✅
  @linchkit/devtools   — Test utilities — ✅

capabilities/ (pluggable):
  @linchkit/cap-adapter-server    — Elysia + graphql-yoga + REST + CommandLayer — 🔧
  @linchkit/cap-adapter-mcp       — MCP transport (adapter capability) — 🔧
  @linchkit/cap-adapter-ui-react  — React + Shadcn + TanStack (official UI shell) — 🔧
  @linchkit/cap-auth              — Authentication (JWT, sessions) — 🔧
  @linchkit/cap-auth-better-auth  — Auth provider (Better Auth) — 🔧
  @linchkit/cap-permission        — Permission (RBAC) — 🔧
  @linchkit/cap-purchase-demo     — Demo: purchase management scenario (private)
```

## Dev Commands

```bash
bun run dev:server                       # Server on :3001
bun run dev:ui                           # UI on :3000, proxies API to :3001
bun test                                 # Run all tests
bun run check                            # Biome lint + format
bun run typecheck                        # TypeScript check

# Database management (requires DATABASE_URL env var)
bun run db:generate                      # Generate migration SQL from schema changes
bun run db:migrate                       # Apply pending migrations
bun run db:studio                        # Open Drizzle Studio GUI

# Reset migrations (dev only — requires DB rebuild, NEVER in production)
# Drop DB → delete migration files → regenerate from current schema
# dropdb linchkit && createdb linchkit
rm -rf drizzle/migrations && bun run db:generate && bun run db:migrate

# Or via CLI directly:
bun ./packages/cli/src/index.ts db generate
bun ./packages/cli/src/index.ts db migrate
bun ./packages/cli/src/index.ts db studio
```

## Key Architecture

- **CommandLayer**: 7-slot middleware pipeline (`pre → auth → exposure → permission → tenant → pre-action → post-action`)
- **REST**: `/api/schemas`, `/api/actions/:name`, `/api/executions`, `/api/tenants`
- **GraphQL**: `/graphql` — CRUD per schema + custom action mutations + execution logs
- **UI Data**: `lib/api.ts` (plain fetch), `hooks/use-schemas.tsx`, Vite proxy, demo data fallback
- **Widget Registry**: `lib/widget-registry.ts` — register/resolve/override field widgets. Each field type has a default display+input pair in `components/widgets/`. Override via `ViewFieldConfig.widget` or `widgetRegistry.overrideDisplay/overrideInput()`. State colors via `lib/state-colors.ts`.
- **AutoList**: `components/auto-list/` — Schema-driven list view. Key sub-components:
  - `SearchBar` — Unified search + filter bar (Odoo Search View equivalent). Combines global fuzzy text search with bazza/ui filter selector (icon button) and active filter pills, all inline in one input-like container.
  - `ListToolbar` — Single-row toolbar: SearchBar on left, action buttons on right (primary + overflow menu + bulk actions).
  - `filter-columns.ts` — Bridge that converts `SchemaDefinition` fields into bazza `ColumnConfig[]` (maps field types to text/number/date/option).
  - `columns.ts` — Builds TanStack Table column defs from `ViewFieldConfig[]`, wiring widget registry for cell rendering.
- **bazza/ui fork**: `components/data-table-filter/` — Forked from [bazza/ui](https://ui.bazza.dev) data-table-filter. Modified to use LinchKit `DeclarativeCondition` format (`ComparisonOperator`: eq, neq, gt, gte, lt, lte, contains, in, not_in, between). Provides `useDataTableFilters` hook, `FilterSelector`, and `ActiveFilters` components.
- **Database Schema Management**: `generateDrizzleSchemaFile()` serializes `SchemaDefinition[]` → pgTable → `.linchkit/drizzle-schema.generated.ts`. Schema changes: `db:generate` creates SQL migration file → `db:migrate` applies via `migrate()` API. Migration files are **append-only in production** — never delete applied migrations. Dev can reset (drop DB + regenerate). System tables live in `_linchkit` PostgreSQL schema, capability tables in `public`.
- **Data Provider**: `DrizzleDataProvider` (PostgreSQL) or `InMemoryStore` fallback (no DB configured). Switch happens in `linch dev` based on `config.database.url`.
- **System Tables**: `_linchkit_executions`, `_linchkit_events`, `_linchkit_approvals` (prefix `_linchkit_` to avoid collision with business tables). Defined in `packages/core/src/persistence/system-tables.ts`.
- **PersistentEventBus**: Events persisted to `_linchkit_events` table when DB is available, in-memory fallback otherwise.
- **Errors**: 7 types → HTTP status (`validation→400`, `not_found→404`, `auth→401`, `authz→403`, `business→422`, `conflict→409`, `system→500`)
- **System fields**: `id`, `tenant_id`, `created_at`, `updated_at`, `created_by`, `updated_by`, `_version`
- **Capability Types**: `standard` (business modules), `adapter` (protocol adapters like MCP/A2A/AG-UI), `bridge` (cross-module connectors). All extend via `extensions: { fieldTypes, viewTypes, ruleEffects, services, hooks, middlewares, transports }`. See spec 20.
- **Protocol Adapters**: Transport adapters (MCP, A2A, AG-UI) are Capabilities (`type: adapter`, `category: integration`) that register via `extensions.transports`. They wrap CommandLayer with protocol-specific transport. Core stays minimal.
- **Flow Engine**: Uses Restate for durable workflow execution. `FlowDefinition` interface defines flows with step types (action, ai, condition, wait, approval, parallel). `FlowCompiler` compiles definitions to executable form. Dual-mode: with Restate server = full durable execution via `RestateFlowEngine` (persistence, retries, timeouts, Saga compensation); without Restate server = `SyncFlowEngine` (steps run sequentially in-process, no durability). `FlowStepContext` provides step-level API (get/set variables, emit events, log). Restate runs as a single Rust binary via Docker (`docker.restate.dev/restatedev/restate:latest`, ports: 8080 ingress, 9070 admin/Web UI). Temporal was explicitly NOT chosen (too heavy: Go server + Cassandra/PG backend, poor Bun compatibility).
- **OntologyRegistry**: Unified semantic layer aggregating all registries (Schema, Action, Rule, State, Event, EventHandler, View, Flow, Link). Read-only facade built once at startup. Key methods: `describe(schemaName)` returns full `SchemaDescriptor`, `listSchemas()`, `searchSchemas(query)`, `actionsFor()`, `rulesFor()`, `stateFor()`, `viewsFor()`, `flowsFor()`, `handlersFor()`, `relatedSchemas()`, `toJSON()`. See spec 43.
- **GraphQL Subscriptions**: SSE-based pub/sub via graphql-yoga. Supports real-time event streaming for schema record changes. Integrated with PersistentEventBus.
- **MCP Tools**: `list_schemas`, `describe_schema` (full SchemaDescriptor via Ontology), `ontology_overview` (high-level system summary), `search_ontology` (keyword search across schemas/actions/rules), `list_actions` (with filter support), `execute_action`, `create_proposal`, `query` (GraphQL proxy). Registered via `extensions.transports` in cap-adapter-mcp.
- **Link Type**: `defineLink()` declares relationships as first-class citizens (spec 46). `LinkRegistry` provides bidirectional navigation (`linksFor`, `outgoingLinks`, `incomingLinks`). Drizzle schema generation handles FK columns (many_to_one, one_to_many) and junction tables (many_to_many with properties). GraphQL resolvers auto-generated for all cardinalities. Schema field `ref`/`has_many`/`many_to_many` auto-promoted to implicit Links.
- **DataLoader Integration**: GraphQL link resolvers use `dataloader` for N+1 query optimization. Per-request DataLoader instances created in GraphQL context, batching related-entity fetches across resolver calls.
- **Schema Interface**: `defineSchemaInterface()` declares reusable field contracts (spec 47). `InterfaceRegistry` validates that implementing schemas include all required fields. Wired into runtime context at startup.
- **Schema Inheritance**: Single-parent inheritance via `extends` field in `SchemaDefinition`. Child schemas inherit parent fields, actions, rules, states. `SchemaRegistry` resolves inheritance chain.
- **Derived Properties**: Computed fields defined via `derived` config in schema fields. Evaluated at query time from other field values. Supported in GraphQL resolvers and CRUD actions.
- **Reactive Automation**: `AutomationEngine` + `TriggerBinding` (spec 45). Event-driven automation rules that bind triggers (action completion, state transition, schedule) to automated action sequences.
- **Soft Delete**: Records marked with `is_deleted` flag instead of physical deletion. GraphQL queries filter soft-deleted records by default. Restore and purge operations available.
- **Tenant API & Switcher**: `/api/tenants` REST endpoint serves static tenant list for UI. `TenantSwitcher` component in UI header allows switching active tenant. JWT tenant extraction reads from actor context, not direct token decode.
- **Data Masking**: Field-level masking rules (spec 41b). `MaskedValue` UI component renders masked fields. Server-side masking applied in GraphQL resolvers based on field config and actor permissions.
- **ApprovalEngine Permission Integration**: Approval decisions respect CommandLayer permission slot. Approvers validated against permission model before approve/reject.
- **Deployment**: Spec 12 — deployment strategies, environment configuration, production readiness checks.
- **Documentation**: Spec 25 — auto-generated API docs, schema documentation, capability documentation.
- **Documentation Governance**: Spec 37 — documentation standards, review process, versioned doc lifecycle.
- **Methodology**: Spec 29 — development methodology, SOP for capability development and release.
- **Versioning & Compatibility**: Spec 38 — release compatibility rules, semantic versioning, migration guides.
- **Capability Hub**: Spec 21b — capability discovery, registry, installation, and dependency resolution.
- **Data Masking & Tenant Isolation**: Spec 41b + spec 30 — field-level data masking rules, tenant isolation via `tenant_id` scoping, row-level security.
- **AI Boundary & AI Security**: Spec 22 + spec 27 — AI rule boundaries (what AI can/cannot modify), AI security hardening (prompt injection defense, output validation, audit trail).

## Test Coverage

- ~2091 tests, 0 failures

## UI Routes

- `/` — Workspace (task-driven dashboard)
- `/schemas/:name` — Schema list view (AutoList)
- `/schemas/:name/new` — Create form (AutoForm)
- `/schemas/:name/:id` — Edit/view form (AutoForm)
- `/admin/executions` — Execution log dashboard

## AI Workflow

This project is entirely AI-generated. See `AGENTS.md` for:
- Development cycle (Claude Code → Codex review → Claude Code fix)
- Architecture guardrails and module boundary rules
- Security constraints (hard rules)
- Review checklist for Codex
- Spec reference table (when to read which spec)

## Serena MCP — Token-Efficient Code Navigation

Project has Serena MCP server configured for semantic code analysis. **Prefer Serena tools over `Read`/`Grep` to minimize token consumption.**

**Exploration workflow:**
1. `get_symbols_overview` — Understand file structure (returns symbol list, ~90% fewer tokens than `Read`)
2. `find_symbol` with `include_body=true` — Read only the specific function/class you need
3. `find_referencing_symbols` — Find where a symbol is used (more precise than `Grep`)
4. `search_for_pattern` — Targeted regex search with scope control

**Fall back to `Read` only when:** reading non-code files, needing full file context, or Serena doesn't cover the use case.

## Specs

Full specs in project: `docs/specs/` (54 files, 00–50).
Key: `03_schema`, `04_action`, `05_rule`, `13_view_and_ui`, `16_command_layer_and_api`, `39_execution_contract`, `45_reactive_automation`, `46_link_type`, `47_schema_interface`, `48_derived_properties`, `49_schema_inheritance`.
