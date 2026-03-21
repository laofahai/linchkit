# LinchKit - Development Instructions

## Overview

AI-Native Software Capability Runtime. **Milestone:** M0b — Core Runtime complete, Server + UI integrated.

Meta-model: **Schema + Action + Rule + State + Event + EventHandler + View + Flow**

## Principles

- **KISS / YAGNI** — Don't build what you don't need
- **Data Structures First** — Design data structures before writing code
- **Communicate in Chinese** — Always use Chinese when talking to the user

## Constraints (MUST follow)

- Runtime: **Bun** (not Node). Use `bunx` never `npx`
- Code quality: **Biome** (no ESLint / Prettier)
- TypeScript **strict mode**
- Registry mirror: `registry.npmmirror.com` (see `.bunfig.toml`)
- Comments/docs: **English**
- Function signatures: Use `{}` options object when > 3 parameters
- GraphQL: **graphql-yoga + graphql-js** code-first (NOT Pothos)
- ORM: **Drizzle** (M0b uses InMemoryStore)
- Pre-commit: `biome check --staged` + `tsc --noEmit` (lefthook)
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

## Dev Server

```bash
bun --watch packages/server/src/dev.ts   # Server on :3001
cd packages/ui && bun run dev            # UI on :3000, proxies API to :3001
bun test                                 # Run all tests
bun run check                            # Biome lint + format
```

## Key Architecture

- **CommandLayer**: 7-slot middleware pipeline (`pre → auth → exposure → permission → tenant → pre-action → post-action`)
- **REST**: `/api/schemas`, `/api/actions/:name`, `/api/executions`
- **GraphQL**: `/graphql` — CRUD per schema + custom action mutations + execution logs
- **UI Data**: `lib/api.ts` (plain fetch), `hooks/use-schemas.tsx`, Vite proxy, demo data fallback
- **Widget Registry**: `lib/widget-registry.ts` — register/resolve/override field widgets. Each field type has a default display+input pair in `components/widgets/`. Override via `ViewFieldConfig.widget` or `widgetRegistry.overrideDisplay/overrideInput()`. State colors via `lib/state-colors.ts` (semantic tokens from `StateMeta.color`).
- **Errors**: 7 types → HTTP status (`validation→400`, `not_found→404`, `auth→401`, `authz→403`, `business→422`, `conflict→409`, `system→500`)
- **System fields**: `id`, `tenant_id`, `created_at`, `updated_at`, `created_by`, `updated_by`, `_version`

## Specs

Full specs in Obsidian vault: `~/Documents/obsidian-vault/01_Projects/AIRE/LinchKit/specs/` (40+ docs).
Key: `03_schema`, `04_action`, `05_rule`, `13_view_and_ui`, `16_command_layer_and_api`, `39_execution_contract`.
