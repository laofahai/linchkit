# LinchKit - Development Instructions

## Overview

AI-Native Software Capability Runtime. **Milestone:** M0b — Core Runtime complete, Server + UI integrated.

Meta-model: **Schema + Action + Rule + State + Event + EventHandler + View + Flow**

## Principles

- **KISS / YAGNI** — Don't build what you don't need
- **Data Structures First** — Design data structures before writing code
- **Communicate in Chinese** — Always use Chinese when talking to the user

## Tech Stack

| Layer | Stack |
|-------|-------|
| Runtime | Bun (not Node) |
| Language | TypeScript strict mode |
| Backend | Elysia |
| GraphQL | graphql-yoga + graphql-js (code-first, NOT Pothos) |
| ORM | Drizzle (M0b uses InMemoryStore) |
| Frontend | React 19 + Vite |
| Routing | TanStack Router |
| UI | Shadcn + Radix + Lucide + Tailwind |
| Table | TanStack Table |
| Form | Zod validation (from SchemaDefinition) |
| Command Palette | cmdk |
| i18n | react-i18next (en / zh-CN) |
| Code quality | Biome (no ESLint / Prettier) |
| Testing | bun test |

## Constraints (MUST follow)

- Use `bunx` never `npx`. E.g. `bunx shadcn@latest add ...`
- Registry mirror: `registry.npmmirror.com` (see `.bunfig.toml`)
- Comments and docs: **English**
- Function signatures: Use `{}` options object when > 3 parameters
- Pre-commit (lefthook): `biome check --staged` + `tsc --noEmit`
- Commit message: **Conventional Commits**

## Packages

```
@linchkit/core       — Types, engines, permission — ✅
@linchkit/cli        — CLI (citty) — ✅
@linchkit/server     — Elysia + graphql-yoga + REST + CommandLayer — 🔧
@linchkit/ui         — React + Shadcn + TanStack — 🔧
@linchkit/devtools   — Test utilities — ✅
@linchkit/mcp        — placeholder
@linchkit/migrate    — placeholder
```

## Dev Commands

```bash
bun --watch packages/server/src/dev.ts   # Server on :3001
cd packages/ui && bun run dev            # UI on :3000, proxies API to :3001
bun test                                 # Run all tests
bun run check                            # Biome lint + format
bun run typecheck                        # TypeScript check
```

## Key Architecture

- **CommandLayer**: 7-slot middleware pipeline (`pre → auth → exposure → permission → tenant → pre-action → post-action`)
- **REST**: `/api/schemas`, `/api/actions/:name`, `/api/executions`
- **GraphQL**: `/graphql` — CRUD per schema + custom action mutations + execution logs
- **UI Data**: `lib/api.ts` (plain fetch), `hooks/use-schemas.tsx`, Vite proxy, demo data fallback
- **Widget Registry**: `lib/widget-registry.ts` — register/resolve/override field widgets. Each field type has a default display+input pair in `components/widgets/`. Override via `ViewFieldConfig.widget` or `widgetRegistry.overrideDisplay/overrideInput()`. State colors via `lib/state-colors.ts`.
- **AutoList**: `components/auto-list/` — Schema-driven list view. Key sub-components:
  - `SearchBar` — Unified search + filter bar (Odoo Search View equivalent). Combines global fuzzy text search with bazza/ui filter selector (icon button) and active filter pills, all inline in one input-like container.
  - `ListToolbar` — Single-row toolbar: SearchBar on left, action buttons on right (primary + overflow menu + bulk actions).
  - `filter-columns.ts` — Bridge that converts `SchemaDefinition` fields into bazza `ColumnConfig[]` (maps field types to text/number/date/option).
  - `columns.ts` — Builds TanStack Table column defs from `ViewFieldConfig[]`, wiring widget registry for cell rendering.
- **bazza/ui fork**: `components/data-table-filter/` — Forked from [bazza/ui](https://ui.bazza.dev) data-table-filter. Modified to use LinchKit `DeclarativeCondition` format (`ComparisonOperator`: eq, neq, gt, gte, lt, lte, contains, in, not_in, between). Provides `useDataTableFilters` hook, `FilterSelector`, and `ActiveFilters` components.
- **Errors**: 7 types → HTTP status (`validation→400`, `not_found→404`, `auth→401`, `authz→403`, `business→422`, `conflict→409`, `system→500`)
- **System fields**: `id`, `tenant_id`, `created_at`, `updated_at`, `created_by`, `updated_by`, `_version`

## UI Routes

- `/` — Workspace (task-driven dashboard)
- `/schemas/:name` — Schema list view (AutoList)
- `/schemas/:name/new` — Create form (AutoForm)
- `/schemas/:name/:id` — Edit/view form (AutoForm)
- `/admin/executions` — Execution log dashboard

## Specs

Full specs in Obsidian vault: `~/Documents/obsidian-vault/01_Projects/AIRE/LinchKit/specs/` (40+ docs).
Key: `03_schema`, `04_action`, `05_rule`, `13_view_and_ui`, `16_command_layer_and_api`, `39_execution_contract`.
