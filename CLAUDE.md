# LinchKit - Development Instructions

## Project Overview

LinchKit is an AI-Native Software Capability Runtime. Tech stack: TypeScript / Bun / Elysia / PostgreSQL / Drizzle / GraphQL (graphql-yoga + graphql-js) / React / Vite / TanStack Router / Shadcn / Biome.

**Current milestone:** M0b — Core Runtime. All engines complete, server + UI integration in progress.

## Core Principles

- **KISS** — Keep it simple
- **YAGNI** — Don't build what you don't need
- **Data Structures First** — Design data structures before writing code
- **Communicate in Chinese** — Always use Chinese when talking to the user

## Technical Constraints

- Runtime: Bun (not Node-compatible)
- Code quality: Biome (no ESLint / Prettier)
- Testing: `bun test` (264+ tests in core, 50+ in server)
- Package management: Bun workspace (monorepo)
- TypeScript: strict mode
- Backend framework: Elysia
- ORM: Drizzle (not yet integrated — using InMemoryStore for M0b)
- GraphQL: graphql-yoga + graphql-js (code-first, NOT Pothos yet)
- Frontend routing: TanStack Router
- UI: Shadcn + Lucide + Tailwind
- Package runner: Always use `bunx` (never `npx`). E.g. `bunx shadcn@latest add ...`
- Registry mirror: `.bunfig.toml` configured with `registry.npmmirror.com` (both project and global `~/.bunfig.toml`)
- Comments and docs: English first
- Function signatures: Use options object `{}` when a function has more than 3 parameters

## Packages

```
@linchkit/core       — Core runtime (defineXxx types, engines) — ✅ complete
@linchkit/cli        — CLI tool (citty: init, dev) — ✅ complete
@linchkit/server     — HTTP server (Elysia + graphql-yoga) — 🔧 in progress
@linchkit/mcp        — MCP adapter (optional) — placeholder
@linchkit/ui         — Frontend UI (React + Shadcn) — 🔧 in progress
@linchkit/migrate    — Migration tools — placeholder
@linchkit/devtools   — Test utilities (testRule, testState, validateCapability) — ✅ basic
```

## Meta-Model

The unified meta-model: **Schema + Action + Rule + State + Event + EventHandler + View + Flow**

- `defineSchema()` — Data model definition, auto-generates Zod / Drizzle / GraphQL types
- `defineAction()` — Write operations (declarative or handler-based)
- `defineRule()` — Business rules: Trigger + Context + Condition + Effect
- `defineState()` — State machine lifecycle management
- `defineEvent()` / `defineEventHandler()` — Event-driven side effects
- `defineView()` — UI view definitions (list / form / kanban / dashboard)
- `defineCapability()` — Module composition unit

## Core Engine APIs

### Schema Engine
- `SchemaRegistry` — register/get/getAll schemas
- `schemaToZod(schema)` — generate Zod validation schema
- `schemaToDrizzle(schema)` — generate Drizzle table definition

### Action Engine
- `createActionExecutor({ dataProvider, stateMachine?, executionLogger? })` — factory
- `executor.execute(actionName, input, actor, options?)` — execute an action
- `executor.registry.register(action)` — register action definitions
- Actions support: permission checks, Zod validation, state transitions, handler execution
- Returns: `{ success, data, executionId }`

### Rule Engine
- `RuleEvaluator` — evaluate rules against triggers
- Supports: declarative conditions (simple/composite/not) + code-based conditions
- Trigger types: action, state_change, field_change, event, schedule

### State Machine
- `createStateMachine(stateDefinition)` — create from definition
- `machine.canTransition(from, to, action?)` — check if transition is valid
- `machine.getAvailableTransitions(currentState)` — list valid next states

### Event Bus
- `createEventBus()` — factory
- `bus.dispatch(event)` — emit an event
- `bus.subscribe(handler)` — register handler (with filter + priority)

### Execution Logger
- `InMemoryExecutionLogger` — records action execution for auditing
- `logger.findMany({ action?, schema?, status?, tenantId?, page?, pageSize? })` — paginated query
- Returns: `{ items: ExecutionLogEntry[], total: number }`

## Server Endpoints

### REST
- `GET /health` — health check
- `POST /api/actions/:name` — execute action (Stripe-style unwrapped body)
- `GET /api/executions` — query execution logs (with filters + pagination)
- `GET /api/executions/:id` — get single execution log entry

### GraphQL (`/graphql`)
- `Query.{schemaName}(id: ID!)` — get record by ID
- `Query.{schemaName}List(filter?, page?, pageSize?, sortField?, sortOrder?)` — paginated list
- `Query.executionLogs(action?, schema?, status?, page?, pageSize?)` — execution log query
- `Query.executionLog(id: ID!)` — single execution log entry
- `Mutation.create{SchemaName}(input)` — create record
- `Mutation.update{SchemaName}(id, input)` — update record
- `Mutation.delete{SchemaName}(id)` — delete record
- `Mutation.{customActionName}(id, input?)` — typed custom action mutation
- `Mutation.executeAction(name, input)` — generic action execution

### Dev Server
- `packages/server/src/dev.ts` — demo with purchase_request schema + submit/approve actions
- Start: `bun --watch packages/server/src/dev.ts` (port 3001)

## UI Architecture

### Pages
- `/` — Workspace (task-driven dashboard)
- `/login` — Login placeholder
- `/schemas/:name` — Schema list view (AutoList)
- `/schemas/:name/new` — Create form (AutoForm)
- `/schemas/:name/:id` — Edit/view form (AutoForm)
- `/admin/executions` — Execution log dashboard

### Key Components
- `AutoList` — TanStack Table-based list, schema-driven columns, sorting, filtering, pagination
- `AutoForm` — Zod-validated form, schema-driven fields, create/edit/view modes
- `FieldRenderer` — FieldDisplay (read) + FieldInput (edit) for all field types
- `CommandPalette` — ⌘K global search/navigation (cmdk)
- `HeaderActions` — Theme toggle, language switcher, notifications, search
- `AppSidebar` — Shadcn collapsible sidebar with nav groups

### i18n
- react-i18next with en/zh-CN locales
- Namespaces: common, nav, workspace, auth, form, list, commandPalette, executionLog, language
- Data layer i18n (JSONB) deferred to M1

## Error Types

7 error categories with HTTP status mapping:
- `validation` → 400 | `not_found` → 404 | `authentication` → 401
- `authorization` → 403 | `business_rule` → 422 | `conflict` → 409 | `system` → 500

## System Fields

Every record has: `id`, `tenant_id`, `created_at`, `updated_at`, `created_by`, `updated_by`, `_version`

## Commands

```bash
bun install          # Install dependencies
bun test             # Run tests
bun run dev          # Start dev server
bun run build        # Production build
bun run check        # Biome lint + format check
bun run typecheck    # TypeScript type check
```

## Quality Gates

- **Pre-commit** (lefthook): `biome check --staged` + `tsc --noEmit`
- **Commit message**: Conventional Commits format required
- **CI** (GitHub Actions): biome + typecheck + test

## Architecture Specs

Full specs in `docs/specs/` (40+ documents). Key ones:
- `03_schema.md` — Schema design
- `04_action.md` — Action design
- `05_rule.md` — Rule design
- `11_execution_log.md` — Execution log design
- `13_view_and_ui.md` — UI design (AI-native principles)
- `16_command_layer_and_api.md` — API contracts
- `30_multi_tenancy.md` — Multi-tenancy (tenant_id)
- `33_error_handling.md` — Error classification
- `39_execution_contract.md` — Unified execution model
