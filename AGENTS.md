# LinchKit - Development Instructions

## Overview

AI-Native Software Capability Runtime. **Milestone:** M3 — Developer Experience, Publishing, AI Workspace.

Meta-model: **Entity + Action + Rule + State + Event + EventHandler + View + Flow + Relation** | Life system: **Sense + Memory + Awareness + Insight + Proposal** (Spec 55)

## Principles

- **KISS / YAGNI** — Don't build what you don't need
- **Data Structures First** — Design data structures before writing code
- **Communicate in Chinese** — Always use Chinese when talking to the user
- **Capability-Centric** — Everything is a Capability (business, system, protocol adapter). No "plugin" concept. See spec 01, 20.
- **Minimal Core** — Core provides only engines + types + pipeline. All concrete implementations (auth, MCP, permissions) are Capabilities.
- **Infinite Extensibility** — New protocols (MCP, A2A, AG-UI), field types, view types, services all register via Capability `extensions`. Core never changes.
- **Action as Sole Write Entry** — All mutations flow through Actions. GraphQL handles reads only.
- **AI Never Modifies Production Directly** — All AI-driven changes go through Proposal → Validation → Approval.

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
| Form | Zod validation (from EntityDefinition) |
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
- No hardcoded secrets, no `eval()`, no `new Function()`, no `any` type
- Sanitize all user inputs; parameterized queries only
- System fields are server-managed, never client-settable
- All API endpoints go through CommandLayer (permission slot never skipped)
- Apply good design patterns and algorithms, but do not over-engineer
- Files must not exceed 500 lines — split when approaching the limit
- Verify third-party API usage with context7 before calling — training data may be stale

## Core Boundary Rules (Three-Way Review Consensus)

**Minimal Core ≠ CRUD only**. Core must retain life-system engines and abstractions (Sense / Memory / Awareness / Insight / Proposal).

**Three-tier classification:**

- **CORE**: Engines + types + pipeline + life-system engines (ActionEngine, RuleEngine, StateMachine, AutomationEngine, ApprovalEngine, ProposalEngine, Flow minimal execution, AI security layer)
- **CORE interface + CAPABILITY implementation**: Core defines abstract interfaces; capabilities provide concrete implementations (e.g. AI Provider SDK → cap-ai-provider, Restate → cap-flow-restate)
- **PURE CAPABILITY**: Dev tooling (doc generation, code quality checks, data migration)

**Must NOT be moved out of core:**

- AutomationEngine (Sense layer engine)
- ApprovalEngine (Rule Engine critical path)
- engine/ProposalEngine (security closed loop)
- Flow interfaces + SyncEngine + TriggerBinding (meta-model first-class citizens)
- AI security layer (AIBoundary, PromptSanitizer, OutputValidator)
- PatternDetector / AnomalyDetector interfaces (Awareness layer abstractions)

**Safe to move out** (already moved):

- Documentation / Methodology / Governance tooling → @linchkit/devtools
- Migration → cap-migration
- RestateFlowEngine → cap-flow-restate
- AI Provider SDK implementations → cap-ai-provider

**Decision criterion:** Before adding new functionality, ask — "Without this, is a zero-capability LinchKit still AI-Native?" If yes → capability. If no → core.

## Packages

```
packages/ (core infrastructure — compiled for npm):
  @linchkit/core       — Types, engines, pipeline
  @linchkit/cli        — CLI launcher (citty)
  @linchkit/devtools   — Test utilities

addons/ (grouped capabilities — OCA model, source-code publishing):
  adapter-server/
    @linchkit/cap-adapter-server    — Elysia + graphql-yoga + REST + CommandLayer
  adapter-ui/
    @linchkit/cap-adapter-ui  — React + Shadcn + TanStack (official UI shell)
    @linchkit/ui-kit           — Shadcn component library
  adapter-mcp/
    @linchkit/cap-adapter-mcp       — MCP transport (adapter capability)
  chatter/
    @linchkit/cap-chatter           — Record timeline: messages, audit log, GraphQL
    @linchkit/cap-chatter-ui  — Chatter React UI panel (autoInstall)
  auth/
    @linchkit/cap-auth              — Authentication (JWT, sessions)
    @linchkit/cap-auth-better-auth  — Auth provider (Better Auth)
  permission/
    @linchkit/cap-permission        — Permission (RBAC)
  ai-provider/
    @linchkit/cap-ai-provider       — AI provider SDK implementations
  flow-restate/
    @linchkit/cap-flow-restate      — Restate durable execution
  migration/
    @linchkit/cap-migration         — Data migration tooling
  demo/
    @linchkit/cap-purchase-demo     — Demo: purchase management scenario (private)
```

**Module boundaries:**
- `core` MUST NOT import from any other package
- `ui` MUST NOT import from `server` (communicates via HTTP/GraphQL only)
- No circular dependencies between packages
- Dependency flows one way: Capability → Core

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
# dropdb linchkit && createdb linchkit
rm -rf drizzle/migrations && bun run db:generate && bun run db:migrate

# Or via CLI directly:
bun ./packages/cli/src/index.ts db generate
bun ./packages/cli/src/index.ts db migrate
bun ./packages/cli/src/index.ts db studio
```

## Meta-Model

- **Entity** — Data structure definition with fields, validations, system fields (`defineEntity()`)
- **Action** — Sole write entry point. Named `verb_noun` (e.g. `submit_request`, `approve_order`) (`defineAction()`)
- **Rule** — Declarative conditions + effects, triggered by actions/events/schedules (`defineRule()`)
- **State** — Finite state machine per entity instance (`defineState()`)
- **Event** — Domain events emitted by actions/state transitions (`defineEvent()`)
- **EventHandler** — Sync/async reactions to events (`defineEventHandler()`)
- **View** — UI rendering config (list, form, kanban) driven by entity (`defineView()`)
- **Flow** — Multi-step durable workflows, Restate dual-mode (`defineFlow()`)
- **Relation** — First-class relationships between entities, bidirectional navigation (`defineRelation()`)

## Capability System

**Types:** `standard` (business modules) | `adapter` (protocol: MCP, A2A, AG-UI) | `bridge` (cross-module connectors)

**Extension Points:**

| Extension | Purpose | Example |
|-----------|---------|---------|
| `fieldTypes` | Custom field types | money, file, address |
| `viewTypes` | Custom view types | map, gantt, timeline |
| `ruleEffects` | Custom rule effects | send_sms, create_ticket |
| `services` | Injectable services | storage, search |
| `hooks` | Lifecycle hooks | system.start, action.before |
| `middlewares` | CommandLayer slot middleware | auth, rate-limit |
| `transports` | Protocol adapters | MCP, A2A, AG-UI |

## Key Architecture

- **CommandLayer**: 7-slot middleware pipeline (`pre → auth → exposure → permission → tenant → pre-action → post-action`)
- **REST**: `/api/entities`, `/api/actions/:name`, `/api/executions`, `/api/tenants`
- **GraphQL**: `/graphql` — CRUD per entity + custom action mutations + execution logs + SSE subscriptions
- **UI Data**: `lib/api.ts` (plain fetch), `hooks/use-schemas.tsx`, Vite proxy, demo data fallback
- **Widget Registry**: `lib/widget-registry.ts` — register/resolve/override field widgets. Each field type has a default display+input pair in `components/widgets/`.
- **AutoList**: `components/auto-list/` — Entity-driven list view with SearchBar, ListToolbar, bazza/ui filters.
- **Database Schema Management**: `generateDrizzleSchemaFile()` serializes `EntityDefinition[]` → pgTable → `.linchkit/drizzle-schema.generated.ts`. Migration files are **append-only in production**.
- **Data Provider**: `DrizzleDataProvider` (PostgreSQL) or `InMemoryStore` fallback (no DB configured).
- **System Tables**: `_linchkit_executions`, `_linchkit_events`, `_linchkit_approvals` (prefix `_linchkit_`).
- **Errors**: 7 types → HTTP status (`validation→400`, `not_found→404`, `auth→401`, `authz→403`, `business→422`, `conflict→409`, `system→500`)
- **System fields**: `id`, `tenant_id`, `created_at`, `updated_at`, `created_by`, `updated_by`, `_version`
- **OntologyRegistry**: Unified semantic layer — `describe()`, `listEntities()`, `searchEntities()`, `actionsFor()`, `relationsFor()`, `toJSON()`. See spec 43.
- **Flow Engine**: Restate dual-mode. With Restate = durable execution; without = `SyncFlowEngine` (sequential, no durability).
- **Relation Type**: `defineRelation()` — FK/junction table generation, GraphQL resolvers auto-generated, DataLoader for N+1 optimization.
- **Entity Interface**: `defineEntityInterface()` — reusable field contracts, compliance validation.
- **Entity Inheritance**: Single-parent via `extends` field.
- **Derived Properties**: Computed fields via `derived` config, evaluated at query time.
- **Reactive Automation**: `AutomationEngine` + `TriggerBinding` (spec 45).
- **Addon Architecture**: OCA-inspired capability grouping (Spec 57). `autoInstall: true` auto-activates when dependencies met.

## Conventions

- **Entity naming:** snake_case
- **Action naming:** verb_noun
- **Comments/docs:** English
- **Commits:** Conventional Commits
- **Function signatures:** Use `{}` options object when > 3 parameters
- **System fields** (auto-managed): `id`, `tenant_id`, `created_at`, `updated_at`, `created_by`, `updated_by`, `_version`

## Patterns to Avoid

- Wrapper/utility files for one-time operations
- Backwards-compatibility shims — just change the code
- Premature abstraction (3 similar lines > 1 abstraction)
- New dependencies without explicit approval
- God objects beyond ~300 lines

## Test Coverage

- ~3675 tests, 0 failures

## UI Routes

- `/` — Workspace (task-driven dashboard)
- `/entities/:name` — Entity list view (AutoList)
- `/entities/:name/new` — Create form (AutoForm)
- `/entities/:name/:id` — Edit/view form (AutoForm)
- `/admin/executions` — Execution log dashboard
- `/admin/metrics` — Metrics dashboard
- `/admin/system-overview` — System health
- `/admin/graph` — Relation graph visualization

## Specs

Full specs in project: `docs/specs/` (62 files, 00–58). Read `docs/specs/INDEX.md` to locate relevant specs.

Key: `03_schema` (Entity), `04_action`, `05_rule`, `13_view_and_ui`, `16_command_layer_and_api`, `39_execution_contract`, `45_reactive_automation`, `46_link_type` (Relation), `47_schema_interface` (Entity Interface), `48_derived_properties`, `49_schema_inheritance` (Entity Inheritance), `57_addon_architecture`.

**Rule**: If you are making changes that touch a spec'd area, read the spec first. Do not guess the design.

## Research

Point-in-time research reports in `docs/research/`:
- `lsp-integration-findings.md` — LSP vs ts-morph analysis for Spec 55 Proposal code validation
- `acp-research-findings.md` — ACP/A2A/MCP protocol landscape analysis

## Serena MCP — Token-Efficient Code Navigation

Project has Serena MCP server configured for semantic code analysis. **Prefer Serena tools over `Read`/`Grep` to minimize token consumption.**

**Exploration workflow:**
1. `get_symbols_overview` — Understand file structure (returns symbol list, ~90% fewer tokens than `Read`)
2. `find_symbol` with `include_body=true` — Read only the specific function/class you need
3. `find_referencing_symbols` — Find where a symbol is used (more precise than `Grep`)
4. `search_for_pattern` — Targeted regex search with scope control

**Fall back to `Read` only when:** reading non-code files, needing full file context, or Serena doesn't cover the use case.

<!-- mulch:start -->
## Project Expertise (Mulch)
<!-- mulch-onboard-v:1 -->

This project uses [Mulch](https://github.com/jayminwest/mulch) for structured expertise management.

**At the start of every session**, run:
```bash
mulch prime
```

This injects project-specific conventions, patterns, decisions, and other learnings into your context.
Use `mulch prime --files src/foo.ts` to load only records relevant to specific files.

**Before completing your task**, review your work for insights worth preserving — conventions discovered,
patterns applied, failures encountered, or decisions made — and record them:
```bash
mulch record <domain> --type <convention|pattern|failure|decision|reference|guide> --description "..."
```

Link evidence when available: `--evidence-commit <sha>`, `--evidence-bead <id>`

Run `mulch status` to check domain health and entry counts.
Run `mulch --help` for full usage.
Mulch write commands use file locking and atomic writes — multiple agents can safely record to the same domain concurrently.

### Before You Finish

1. Discover what to record:
   ```bash
   mulch learn
   ```
2. Store insights from this work session:
   ```bash
   mulch record <domain> --type <convention|pattern|failure|decision|reference|guide> --description "..."
   ```
3. Validate and commit:
   ```bash
   mulch sync
   ```
<!-- mulch:end -->

<!-- seeds:start -->
## Issue Tracking (Seeds)
<!-- seeds-onboard-v:1 -->

This project uses [Seeds](https://github.com/jayminwest/seeds) for git-native issue tracking.

**At the start of every session**, run:
```
sd prime
```

This injects session context: rules, command reference, and workflows.

**Quick reference:**
- `sd ready` — Find unblocked work
- `sd create --title "..." --type task --priority 2` — Create issue
- `sd update <id> --status in_progress` — Claim work
- `sd close <id>` — Complete work
- `sd dep add <id> <depends-on>` — Add dependency between issues
- `sd sync` — Sync with git (run before pushing)

### Before You Finish
1. Close completed issues: `sd close <id>`
2. File issues for remaining work: `sd create --title "..."`
3. Sync and push: `sd sync && git push`
<!-- seeds:end -->
