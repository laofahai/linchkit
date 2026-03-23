# AGENTS.md

> AI-Native Software Capability Runtime. Meta-model: **Schema + Action + Rule + State + Event + EventHandler + View + Flow**.

## Architecture Principles

1. **Capability-Centric** — Everything is a Capability. No "plugin" concept. Business modules, system services, protocol adapters — all Capabilities.
2. **Minimal Core** — Core provides only engines + types + pipeline. All concrete implementations are Capabilities.
3. **Infinite Extensibility** — New protocols, field types, views, services register via Capability `extensions`. Core never changes.
4. **Action as Sole Write Entry** — All mutations flow through Actions. GraphQL handles reads only.
5. **AI Never Modifies Production Directly** — All AI-driven changes go through Proposal → Validation → Approval.

## Tech Stack

- **Runtime:** Bun (never Node). Use `bunx` not `npx`.
- **Language:** TypeScript strict mode
- **Backend:** Elysia + graphql-yoga + graphql-js (code-first, NOT Pothos)
- **ORM:** Drizzle (M0b uses InMemoryStore)
- **Frontend:** React 19 + Vite + TanStack Router + TanStack Table
- **UI:** Shadcn + Radix + Lucide + Tailwind
- **Code Quality:** Biome (no ESLint / Prettier)
- **Testing:** bun test
- **i18n:** react-i18next (en / zh-CN)

## Project Structure

```
packages/ (core infrastructure):
  @linchkit/core       — Engines, types, pipeline
  @linchkit/cli        — CLI launcher (citty)
  @linchkit/devtools   — Test utilities

capabilities/ (pluggable):
  @linchkit/cap-adapter-server    — HTTP/GraphQL transport (Elysia + graphql-yoga)
  @linchkit/cap-adapter-mcp       — MCP transport for AI agents
  @linchkit/cap-adapter-ui-react  — Official UI shell (React + Shadcn + TanStack)
  @linchkit/cap-auth              — Authentication
  @linchkit/cap-auth-better-auth  — Auth provider (Better Auth)
  @linchkit/cap-permission        — Permission engine
```

**Module boundaries:**
- `core` MUST NOT import from any other package
- `ui` MUST NOT import from `server` (communicates via HTTP/GraphQL only)
- No circular dependencies between packages

## Capability System

**Types:** `standard` (business modules) | `adapter` (protocol: MCP, A2A, AG-UI) | `bridge` (cross-module connectors)

**Categories:** system | infrastructure | integration | business | ui | utility | starter

### Extension Points

Capabilities extend the framework via `extensions`:

| Extension | Purpose | Example |
|-----------|---------|---------|
| `fieldTypes` | Custom field types | money, file, address |
| `viewTypes` | Custom view types | map, gantt, timeline |
| `ruleEffects` | Custom rule effects | send_sms, create_ticket |
| `services` | Injectable services | storage, search |
| `hooks` | Lifecycle hooks | system.start, action.before |
| `middlewares` | CommandLayer slot middleware | auth, rate-limit |
| `transports` | Protocol adapters | MCP, A2A, AG-UI |

## Meta-Model

- **Schema** — Data structure definition with fields, validations, system fields
- **Action** — Sole write entry point. Named `verb_noun` (e.g. `submit_request`, `approve_order`)
- **Rule** — Declarative conditions + effects, triggered by actions/events/schedules
- **State** — Finite state machine per schema instance
- **Event** — Domain events emitted by actions/state transitions
- **EventHandler** — Sync/async reactions to events (priority, filter)
- **View** — UI rendering config (list, form, kanban) driven by schema
- **Flow** — Multi-step workflows (Temporal, M1+)

## Command Layer

All entry points (HTTP / MCP / CLI / UI) share one pipeline:

```
pre → auth → exposure → permission → tenant → pre-action → [action] → post-action
```

## API Endpoints

- **REST:** `POST /api/actions/:name` (execute), `GET /api/schemas` (list), `GET /api/executions` (logs)
- **GraphQL:** `/graphql` — Auto-generated CRUD per schema + custom action mutations + execution queries

## Error Types

`validation → 400` | `not_found → 404` | `auth → 401` | `authz → 403` | `business → 422` | `conflict → 409` | `system → 500`

## Development

```bash
bun run dev:server                       # Server :3001
bun run dev:ui                           # UI :3000 (proxies to :3001)
bun test                                 # All tests
bun run check                            # Biome lint + format
bun run typecheck                        # TypeScript check
```

## Conventions

- **Schema naming:** snake_case
- **Action naming:** verb_noun
- **Comments/docs:** English
- **Commits:** Conventional Commits
- **Function signatures:** Use `{}` options object when > 3 parameters
- **Pre-commit (lefthook):** `biome check --staged` + `tsc --noEmit`
- **Registry mirror:** `registry.npmmirror.com` (see `.bunfig.toml`)
- **System fields** (auto-managed): `id`, `tenant_id`, `created_at`, `updated_at`, `created_by`, `updated_by`, `_version`

## Security Constraints

- No hardcoded secrets, no `eval()`, no `new Function()`, no `any` type
- Sanitize all user inputs; parameterized queries only
- System fields are server-managed, never client-settable
- All API endpoints go through CommandLayer (permission slot never skipped)
- AI actions are subject to the same permission model as human actions

## Key Constraints

1. Action is the **sole write entry point**. Never bypass it.
2. AI never modifies production directly — Proposal → Validation → Approval.
3. Rule Engine runs independently of AI decisions.
4. Core never imports from Capabilities. Dependency flows one way: Capability → Core.
5. All concrete auth, permission, MCP implementations are Capabilities, not core.
6. Do not add features not requested (YAGNI). Do not over-abstract.
7. Search for existing implementations before writing new ones — no duplication.

## Patterns to Avoid

- Wrapper/utility files for one-time operations
- Backwards-compatibility shims — just change the code
- Premature abstraction (3 similar lines > 1 abstraction)
- New dependencies without explicit approval
- God objects beyond ~300 lines

## Specs

Design specs live in `docs/specs/` (47 files, 00–50).

Key refs: `03_schema`, `04_action`, `05_rule`, `06_state`, `07_event`, `10_actor_permission`, `13_view_and_ui`, `16_command_layer_and_api`, `33_error_handling`, `35_approval_mechanism`, `36_ai_service`, `39_execution_contract`.

**Rule**: If you are making changes that touch a spec'd area, read the spec first. Do not guess the design.

## Serena MCP — Token-Efficient Code Navigation

Use Serena's semantic tools instead of reading entire files to save tokens:

1. `get_symbols_overview` — File structure overview (~90% fewer tokens than reading the file)
2. `find_symbol(name, include_body=true)` — Read only the function/class you need
3. `find_referencing_symbols` — Precise reference search (better than grep for symbols)
4. `search_for_pattern` — Scoped regex search

Fall back to full file reads only for non-code files or when full context is truly needed.
