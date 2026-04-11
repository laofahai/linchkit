# LinchKit — AI-Native Software Capability Runtime

## Overview

Meta-model: **Entity + Action + Rule + State + Event + EventHandler + View + Flow + Relation**
Life system: **Sense + Memory + Awareness + Insight + Proposal** (Spec 55)

## Principles

- **KISS / YAGNI** — Don't build what you don't need
- **Data Structures First** — Design data structures before writing code
- **Communicate in Chinese** — Always use Chinese when talking to the user
- **Capability-Centric** — Everything is a Capability (business, system, protocol adapter). No "plugin" concept.
- **Minimal Core** — Core provides only engines + types + pipeline. All concrete implementations are Capabilities.
- **Action as Sole Write Entry** — All mutations flow through Actions. GraphQL handles reads only.
- **AI Never Modifies Production Directly** — All AI-driven changes go through Proposal → Validation → Approval.

## Workflow Entry Point

**All development tasks MUST begin by invoking `/linch-workflow`.** This skill routes to the correct sub-skill based on task type (capability dev, core engine, bug fix, UI, docs) and enforces the full development lifecycle. Do not skip this step.

If a spec exists for the area you're touching → read the spec first. Specs: `docs/specs/INDEX.md`

## Tech Stack

| Layer | Stack |
|-------|-------|
| Runtime | Bun (not Node) |
| Language | TypeScript strict mode |
| Backend | Elysia |
| GraphQL | graphql-yoga + graphql-js (code-first, NOT Pothos) |
| ORM | Drizzle (PostgreSQL via drizzle-kit, InMemoryStore fallback) |
| Frontend | React 19 + Vite |
| UI | Shadcn + Radix + Lucide + Tailwind |
| Flow Engine | Restate (`@restatedev/restate-sdk` v1.11.1) — durable execution |
| Testing | bun test |

## Constraints

- Registry mirror: `registry.npmmirror.com` (see `.bunfig.toml`)
- Comments and docs: **English**
- Function signatures: Use `{}` options object when > 3 parameters
- drizzle-kit: Use `bun ./node_modules/.bin/drizzle-kit` (NOT `bunx drizzle-kit` — EPIPE bug on macOS)
- Database DDL: **Never hand-write CREATE TABLE / ALTER TABLE** — always delegate to drizzle-kit
- No hardcoded secrets, no `eval()`, no `new Function()`, no `any` type
- Sanitize all user inputs; parameterized queries only
- System fields are server-managed, never client-settable
- All API endpoints go through CommandLayer (permission slot never skipped)
- Verify third-party API usage with context7 before calling — training data may be stale
- New dependencies require explicit approval

## Repository Structure

```
packages/ (core infrastructure — compiled for npm):
  @linchkit/core       — Types, engines, pipeline
  @linchkit/cli        — CLI launcher (citty)
  @linchkit/devtools   — Test utilities

addons/ (capabilities — OCA model):
  adapter-server/      — Elysia + GraphQL + REST
  adapter-ui/          — React UI + Shadcn ui-kit
  adapter-mcp/         — MCP transport
  chatter/             — Record timeline (cap-chatter + cap-chatter-ui)
  auth/                — Authentication (cap-auth + cap-auth-better-auth)
  permission/          — RBAC (cap-permission)
  ai-provider/         — AI providers (cap-ai-provider)
  flow-restate/        — Restate workflows (cap-flow-restate)
  migration/           — Data migration (cap-migration)
  demo/                — Purchase demo (private)
```

**Module boundaries:** `core` never imports from other packages. `ui` never imports from `server`. No circular deps.

**Core boundary:** "Without this, is a zero-capability LinchKit still AI-Native?" Yes → capability. No → core.

## Dev Commands

```bash
bun run dev:server    # Server on :3001
bun run dev:ui        # UI on :3000, proxies API to :3001
bun test              # Run all tests
bun run check         # Biome lint + format
bun run typecheck     # TypeScript check
linch validate        # Meta-model validation
linch setup           # Sync AI tool configs (skills, MCP)
linch agents-md       # Generate AGENTS.md for downstream projects
```

## Meta-Model

- **Entity** — `defineEntity()` — data structure definition
- **Action** — `defineAction()` — sole write entry point, named `verb_noun`
- **Rule** — `defineRule()` — declarative conditions + effects
- **State** — `defineState()` — finite state machine per entity
- **Event** — `defineEvent()` — domain events
- **EventHandler** — `defineEventHandler()` — sync/async reactions
- **View** — `defineView()` — UI rendering config
- **Flow** — `defineFlow()` — multi-step durable workflows
- **Relation** — `defineRelation()` — first-class entity relationships

## Key Architecture

- **CommandLayer**: 7-slot middleware (`pre → auth → exposure → permission → tenant → pre-action → post-action`)
- **REST**: `/api/entities`, `/api/actions/:name`, `/api/executions`
- **GraphQL**: `/graphql` — CRUD + action mutations + SSE subscriptions
- **OntologyRegistry**: Unified semantic layer — `describe()`, `listEntities()`, `actionsFor()`
- **Addon Architecture**: OCA-inspired grouping (Spec 57). `autoInstall: true` auto-activates.

## Conventions

- **Entity naming:** snake_case, singular nouns
- **Action naming:** verb_noun (`submit_request`, `approve_order`)
- **System fields** (auto-managed): `id`, `tenant_id`, `created_at`, `updated_at`, `created_by`, `updated_by`, `_version`

## Git Workflow

- Main worktree stays on `main` as dispatch hub. Use `git worktree add` for tasks.
- Branch naming: `fix/`, `feat/`, `refactor/`, `docs/`, `chore/` prefixes.
- Hooks enforce: no commits to `main`, no `git checkout -b` on main, no `npx`/`npm`/`node`.

## Gemini CLI Collaboration

When the user says "与Gemini商讨" or similar:
1. Generate prompt as `$PROMPT`
2. Call: `gemini <<EOF\n$PROMPT\nEOF`
