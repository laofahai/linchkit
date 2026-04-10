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

---

## Development Workflow

### Phase 1: Orient

Every new session MUST begin by understanding current state:

1. Read this file (CLAUDE.md) for conventions and constraints
2. Read `docs/specs/INDEX.md` for spec status, tracking links, and relevant design docs
3. Check GitHub milestones and issues for active execution truth
4. Ask the user what to work on

**Execution rule:** GitHub milestones and issues are the authoritative task tracker. Specs define target design and stable constraints. README is background only, not a task source.

### Phase 2: Spec First

Before writing any implementation code:

1. **If a spec exists** for the area you're touching → read the spec first. Do not guess the design.
2. **If no spec exists** for a new feature → write a minimal spec in `docs/specs/` before coding.
3. **If the spec is outdated** → update the spec to match the intended design, then implement.

Spec format: see existing specs in `docs/specs/` for the pattern.

### Phase 3: Implement

1. **Data structures first** — Design types and interfaces before writing logic
2. **MUST invoke relevant Skills BEFORE writing code** — Use `Skill` tool to load `/linch-*` skills. Match by domain: entity work → `/linch-entity-design`, action work → `/linch-action-design`, new capability → `/linch-capability-dev`, etc. Skills contain checklists and constraints that prevent design mistakes. Skipping skills leads to rework.
3. **MUST use LinchKit MCP tools for discovery** — Before exploring code with Read/Grep, use `ToolSearch` to load `mcp__linchkit__*` tools, then call `list_entities`, `get_entity`, `list_actions` etc. These provide structured metadata far more efficient than file scanning. See "LinchKit MCP — Development Tools" section below.
4. **Write tests alongside code** — Not after. Use `/test` skill.
5. **Keep files under 500 lines** — Split by responsibility
6. **Unrelated issues** — If you discover pre-existing bugs, lint errors, or tech debt unrelated to the current task: **do not fix them in the same PR**. Create a GitHub issue (`gh issue create`) to track them, then continue with the current task.

### Phase 4: Verify

All four quality gates MUST pass before committing:

```bash
linch validate        # Meta-model validation
bun run check         # Biome lint + format
bun run typecheck     # TypeScript strict check
bun test              # Full test suite (3870+ tests)
```

### Phase 5: PR & Review

1. **Create branch** — `feat/xxx`, `fix/xxx`, `refactor/xxx`
2. **Push and create PR** — Use `gh pr create`
3. **Wait for CI** — GitHub Actions runs all quality gates
4. **Read review comments** — CodeRabbit and/or human reviewers
5. **Fix and resolve** — Address every comment, push fixes
6. **Reply to each comment** — Explain what was fixed, then **resolve** the thread (NEVER dismiss)
7. **All comments resolved + CI green + APPROVED** → merge

**PR merge rules (MANDATORY — no exceptions):**

1. **NEVER use `--admin` or `--auto` flag** — If `gh pr merge` is blocked by policy, that means reviews are not done. WAIT.
2. **NEVER merge with CHANGES_REQUESTED status** — Must wait for reviewers to re-approve after fixes. Request re-review explicitly if needed.
3. **NEVER dismiss review threads** — Always reply explaining the fix, then resolve via GraphQL `resolveReviewThread`.
4. **ALWAYS read ALL review comments BEFORE attempting merge** — Every single comment from CodeRabbit, Gemini, or human reviewers must be read, understood, and either fixed or explicitly replied to with reasoning.
5. **Only merge when: review status = APPROVED + CI = green** — Both conditions must be true. No shortcuts.

### Parallel Subagent Dispatch

When multiple independent issues can be worked on simultaneously:

1. **Subagents only write code** — Dispatch with `isolation: "worktree"`. Instruct agents to do file changes only, NOT `git commit/push` or `gh pr create`.
1a. **Orchestrator invokes Skills first** — Skills can only run in the main agent. Before dispatching subagents, invoke the relevant `/linch-*` skill and include the skill's checklist/constraints in the subagent prompt. This ensures subagents follow design rules even without direct Skill access.
1b. **Subagents MUST use MCP tools** — Include in the subagent prompt: "Use `ToolSearch('mcp__linchkit')` to load LinchKit MCP tools, then use `list_entities`, `get_entity` etc. for discovery instead of file scanning."
2. **Worktree starts from `origin/HEAD` (main)** — Agents always work on a fresh branch from main. Do NOT instruct agents to `git checkout` another branch — they should make changes directly in their worktree.
3. **Orchestrator handles git** — After agents complete, the orchestrator creates a feat branch, copies files from worktree via `cp`, commits, pushes, and creates PRs.
4. **Bash `cd` persists** — Working directory carries over between Bash calls. Always use `cd /absolute/path && git ...` in a single Bash call. Never assume you're in the main repo.
5. **No file overlap** — Ensure parallel branches don't modify the same files to avoid merge conflicts.
6. **Retrieving worktree files** — Use `cp <worktree-path>/file <main-repo>/file`. Do NOT use `git checkout <worktree-path>` — worktree paths are not git refs.

### Phase 6: Close

After merging:

1. **Update `docs/specs/INDEX.md`** — If a spec's implementation status changed
2. **Add changeset** — If npm-published code changed: `bunx changeset`
3. **Close related GitHub issues** — `gh issue close <number>`
4. **Clean up local branches** — Delete the merged feature branch: `git branch -d <branch>`
5. **Clean up worktrees** — If subagents were used, remove worktrees and their branches:
   ```bash
   git worktree remove .claude/worktrees/<agent-id>
   git branch -D worktree-agent-<id>
   ```
6. **Prune remote tracking** — `git remote prune origin` to clean stale remote refs

### Hygiene Rules

- **Never leave worktrees after task completion** — Remove worktrees as soon as files are copied and committed. Do not accumulate across sessions.
- **Never leave local branches after PR merge** — Delete immediately in Phase 6.
- **Session start cleanup** — If stale worktrees or branches exist from prior sessions, clean them before starting new work.
- **New issues must have a priority label** — Use P0-P3 from the issue template.

---

## Repository Structure

This is the **core monorepo**. Official capabilities will migrate to a separate repo.

```
packages/ (core infrastructure — compiled for npm):
  @linchkit/core       — Types, engines, pipeline
  @linchkit/cli        — CLI launcher (citty)
  @linchkit/devtools   — Test utilities

addons/ (capabilities — OCA model, will migrate to separate repo):
  adapter-server/      — @linchkit/cap-adapter-server (Elysia + GraphQL + REST)
  adapter-ui/          — @linchkit/cap-adapter-ui + @linchkit/ui-kit (React + Shadcn)
  adapter-mcp/         — @linchkit/cap-adapter-mcp (MCP transport)
  chatter/             — @linchkit/cap-chatter + @linchkit/cap-chatter-ui
  auth/                — @linchkit/cap-auth + @linchkit/cap-auth-better-auth
  permission/          — @linchkit/cap-permission
  ai-provider/         — @linchkit/cap-ai-provider
  flow-restate/        — @linchkit/cap-flow-restate
  migration/           — @linchkit/cap-migration
  demo/                — @linchkit/cap-purchase-demo (private)
```

**Module boundaries:**
- `core` MUST NOT import from any other package
- `ui` MUST NOT import from `server` (communicates via HTTP/GraphQL only)
- No circular dependencies between packages
- Dependency flows one way: Capability → Core

## Core Boundary Rules

**CORE**: Engines + types + pipeline + life-system engines
**CORE interface + CAPABILITY implementation**: Core defines abstract interfaces; capabilities provide concrete implementations
**PURE CAPABILITY**: Everything else

**Decision criterion:** "Without this, is a zero-capability LinchKit still AI-Native?" If yes → capability. If no → core.

---

## Dev Commands

```bash
bun run dev:server                       # Server on :3001
bun run dev:ui                           # UI on :3000, proxies API to :3001
bun test                                 # Run all tests
bun run check                            # Biome lint + format
bun run typecheck                        # TypeScript check
linch validate                           # Meta-model validation
linch setup                              # Sync AI tool configs (skills, MCP)
linch agents-md                          # Generate AGENTS.md for downstream projects
linch doctor                             # Project health checks

# Database management
bun run db:generate                      # Generate migration SQL
bun run db:migrate                       # Apply pending migrations
bun run db:studio                        # Drizzle Studio GUI
```

## Meta-Model

- **Entity** — Data structure definition (`defineEntity()`)
- **Action** — Sole write entry point, named `verb_noun` (`defineAction()`)
- **Rule** — Declarative conditions + effects (`defineRule()`)
- **State** — Finite state machine per entity instance (`defineState()`)
- **Event** — Domain events emitted by actions/state transitions (`defineEvent()`)
- **EventHandler** — Sync/async reactions to events (`defineEventHandler()`)
- **View** — UI rendering config (`defineView()`)
- **Flow** — Multi-step durable workflows (`defineFlow()`)
- **Relation** — First-class relationships between entities (`defineRelation()`)

## Key Architecture

- **CommandLayer**: 7-slot middleware pipeline (`pre → auth → exposure → permission → tenant → pre-action → post-action`)
- **REST**: `/api/entities`, `/api/actions/:name`, `/api/executions`, `/api/tenants`
- **GraphQL**: `/graphql` — CRUD + action mutations + execution logs + SSE subscriptions
- **OntologyRegistry**: Unified semantic layer — `describe()`, `listEntities()`, `searchEntities()`, `actionsFor()`, `relationsFor()`
- **Flow Engine**: Restate dual-mode (with Restate = durable; without = SyncFlowEngine)
- **Addon Architecture**: OCA-inspired grouping (Spec 57). `autoInstall: true` auto-activates when dependencies met.

## Conventions

- **Entity naming:** snake_case, singular nouns
- **Action naming:** verb_noun (`submit_request`, `approve_order`)
- **Comments/docs:** English
- **Commits:** Conventional Commits
- **System fields** (auto-managed): `id`, `tenant_id`, `created_at`, `updated_at`, `created_by`, `updated_by`, `_version`

## Patterns to Avoid

- Wrapper/utility files for one-time operations
- Backwards-compatibility shims — just change the code
- Premature abstraction (3 similar lines > 1 abstraction)
- New dependencies without explicit approval
- God objects beyond ~300 lines
- `node`, `npx`, `npm` — always use `bun`, `bunx`

## Specs

Full specs in `docs/specs/` (66 files). Read `docs/specs/INDEX.md` to locate relevant specs.

**Rule**: If you are making changes that touch a spec'd area, read the spec first.

## LinchKit MCP — Development Tools (MANDATORY)

When implementing features, use LinchKit MCP tools instead of manual file exploration:

1. Load tools first: `ToolSearch("mcp__linchkit")`
2. **Discovery** — `list_entities`, `get_entity`, `list_actions`, `get_state_machine`, `get_rules` — structured metadata, no file scanning needed
3. **Validation** — `validate_entity`, `validate_action` — check definitions before running full `linch validate`
4. **Scaffolding** — `scaffold_capability`, `scaffold_action`, `scaffold_rule` — generate correct templates
5. **Querying** — `query` — run GraphQL queries against running dev server

**When to use:** Any task involving entities, actions, rules, relations, or state machines. The MCP tools provide the same information as reading source files but in structured form, saving tokens and reducing errors.

**When NOT to use:** Reading non-code files (specs, docs), git operations, or when MCP server is not running.

## Serena MCP — Token-Efficient Code Navigation

Prefer Serena tools over `Read`/`Grep` to minimize token consumption:
1. `get_symbols_overview` — Understand file structure (~90% fewer tokens than `Read`)
2. `find_symbol` with `include_body=true` — Read only the specific function/class you need
3. `find_referencing_symbols` — Find where a symbol is used
4. `search_for_pattern` — Targeted regex search with scope control

Fall back to `Read` only when reading non-code files or needing full file context.

## Gemini CLI Collaboration

When the user says "与Gemini商讨" or similar:
1. Generate prompt as `$PROMPT`
2. Call: `gemini <<EOF\n$PROMPT\nEOF`
