# LinchKit - Development Instructions

## Project Overview

LinchKit is an AI-Native Software Capability Runtime. Tech stack: TypeScript / Bun / Elysia / PostgreSQL / Drizzle / GraphQL (Pothos) / React / Vite / TanStack Router / Shadcn / Biome.

## Core Principles

- **KISS** — Keep it simple
- **YAGNI** — Don't build what you don't need
- **Data Structures First** — Design data structures before writing code
- **Communicate in Chinese** — Always use Chinese when talking to the user

## Technical Constraints

- Runtime: Bun (not Node-compatible)
- Code quality: Biome (no ESLint / Prettier)
- Testing: `bun test`
- Package management: Bun workspace (monorepo)
- TypeScript: strict mode
- Backend framework: Elysia
- ORM: Drizzle
- GraphQL: graphql-yoga + Pothos (code-first)
- Frontend routing: TanStack Router
- UI: Shadcn + Lucide + Tailwind
- Comments and docs: English first

## Packages

```
@linchkit/core       — Core runtime (defineXxx types, engines)
@linchkit/cli        — CLI tool (citty)
@linchkit/server     — HTTP server (Elysia + GraphQL)
@linchkit/mcp        — MCP adapter (optional)
@linchkit/ui         — Frontend UI + headless hooks
@linchkit/migrate    — Migration tools
@linchkit/devtools   — Test utilities (testRule, testAction, etc.)
```

## Meta-Model

The unified meta-model: **Schema + Action + Rule + State + Event + EventHandler + View + Flow**

- `defineSchema()` — Data model definition, auto-generates Zod / Drizzle / GraphQL / TS types
- `defineAction()` — Write operations (declarative or handler-based)
- `defineRule()` — Business rules: Trigger + Context + Condition + Effect
- `defineState()` — State machine lifecycle management
- `defineEvent()` / `defineEventHandler()` — Event-driven side effects
- `defineView()` — UI view definitions (list / form / kanban / dashboard)
- `defineCapability()` — Module composition unit

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
