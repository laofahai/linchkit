# Milestone M1 Plan — Persistence, Flow, Ecosystem

> Status: Active | Date: 2026-03-22
> **Last Updated**: 2026-03-25
> Prerequisite: **✅ M0b complete** (auth/permission integration finalized)
>
> ### Current Progress
> - ✅ M0b: 100% complete (all tasks done, all tests passing)
> - ✅ M1a Stage 1: Drizzle ORM Infrastructure 100% complete
> - ✅ M1a Stage 2: Migration System 100% complete (uses `migrate()` API instead of buggy `push`)
> - ✅ M1a Stage 3: RuntimeContext Switch 100% complete (PostgreSQL + InMemory fallback)
> - ✅ M1a Stage 4: Event Persistence + Outbox 100% complete
> - ✅ M1a Stage 5: Flow Engine (Restate) 100% complete (FlowDefinition types, SyncFlowEngine, FlowStepContext, dual-mode)
> - ✅ M1b Phase 1: MCP Adapter Enhanced — complete (describe_schema, ontology_overview, search_ontology, list_actions filter)
> - ✅ M1b Phase 3: AI Proposal — basics complete (OntologyRegistry integration, ProposalGenerationError, prompt optimization)
> - ✅ M1b Phase 4: CLI Ecosystem — basics complete (create-capability enhanced, install --dry-run, info command)
> - ✅ M1b Phase 5: i18n — data layer complete
> - ✅ M2: Link Type 100% complete (including M:N support ahead of schedule)
> - ✅ M2: OntologyRegistry 100% complete (describe, listSchemas, searchSchemas, actionsFor, rulesFor, stateFor, viewsFor, flowsFor, handlersFor, relatedSchemas, toJSON)
> - ✅ M2: GraphQL Subscriptions — basics complete (SSE-based pub/sub)
> - ✅ M2: MCP Adapter + Ontology integration — complete
> - ✅ M2: Cache Strategy (spec 34) — complete
> - ✅ M2: AI Rule Boundary (spec 22) — complete
> - ✅ M2: Schema Interface (spec 47) — complete
> - ✅ M2: Data Masking (spec 41b) — complete
> - ✅ M2: Tenant Isolation (spec 30) — complete
> - ✅ M2: Metrics Wiring into core engines — complete
> - ✅ M2: Derived Properties (spec 48) — complete
> - ✅ M2: Reactive Automation (spec 45) — complete
> - ✅ M2: Schema Inheritance (spec 49) — complete
> - ✅ M2: Runtime Config Center (spec 42) — complete
> - ✅ M2: Observability Metrics (spec 28) — complete
> - ✅ M2: OutboxWorker production reliability — complete
> - ✅ M2: Flow AIStep tool calling — complete
> - ✅ Spec 12: Deployment — complete
> - ✅ Spec 17: Legacy Migration — complete
> - ✅ Spec 21b: Capability Hub — complete
> - ✅ Spec 25: Documentation — complete
> - ✅ Spec 27: AI Security — complete (AI Rule Boundary + AI security hardening)
> - ✅ Spec 29: Methodology — complete
> - ✅ Spec 37: Documentation Governance — complete
> - ✅ Spec 38: Release Compatibility — complete
>
> ### Test Coverage
> - ~1983 tests, 0 failures
>
> ### Tech Debt Fixed (2026-03-25)
> - 12 items resolved: resolveApiKey, permission self-registration, identifier validation, Link FK column merging, GraphQL Link resolver tests, console logger fixes, schema-to-zod improvements, schema-to-drizzle Link support, flow types refinement, transport types update, validation engine enhancements, proposal generator improvements
>
> ### Integration Wiring Completed (2026-03-25)
> - GraphQL state transitions: availableTransitions query + transition mutation
> - GraphQL optimistic locking: _version check with 409 conflict response
> - GraphQL translatable field resolution: read + write paths
> - AIBoundary + AIAuditLogger wired into server + flow engine
> - TenantAwareDataProvider wired into ActionExecutor
> - DerivedPropertyEngine wired into CRUD + GraphQL
> - AutomationEngine wired into server lifecycle
> - InterfaceRegistry wired into server startup
> - InMemoryStore extracted to @linchkit/core (shared, with optimistic locking)
> - Large file splits (build-schema, dev.ts)
> - 5 CLI commands: docs, check, changelog, validate, info
> - 4 MCP AI security tools
> - Purchase demo enhanced (interfaces, derived, automations, masking)
>
> ### Architecture Improvements
> - **Browser/Server Boundaries**: Clean separation of browser-safe and server-only code paths across all packages
> - **Error Hierarchy**: Structured error types with proper HTTP status mapping (validation→400, auth→401, authz→403, not_found→404, business→422, conflict→409, system→500)
> - **EventBusLike Decoupling**: Core engines depend on `EventBusLike` interface, not concrete EventBus — enables in-memory, persistent, and test implementations interchangeably
>
> ### Remaining Work (TODO)
> - Final polish and M2 remaining items

## Overview

M1 splits into three phases: **M0b Completion** (auth/permission wiring), **M1a** (data persistence + Flow engine), and **M1b** (ecosystem extension + AI integration).

```
M0b Completion (1-2 days)
    ↓
M1a: Persistence + Flow (~19 days)
    ↓
M1b: Ecosystem + AI (~6 weeks)
```

---

## Phase 0: M0b Completion — Auth/Permission Integration

### Current Gaps

| # | Gap | Impact |
|---|-----|--------|
| 1 | `linchkit.config.ts` uses static `capAuth` (contract only, no handler/middleware) | Login action has no handler, all requests are anonymous |
| 2 | CommandLayer catch block only handles `ExposureError`/`PipelineError`, not `LinchKitError` | Auth/permission errors return as "Internal pipeline error" |
| 3 | Server `resolveStatusCode()` doesn't map auth error codes to 401/403 | Wrong HTTP status on auth failures |
| 4 | No `createCapPermission` factory | Permission middleware not wired |
| 5 | `ANONYMOUS_ACTOR` has `groups: ["admin"]` — unsafe bypass | All unauthenticated requests get admin privileges |
| 6 | No AuthContext / useAuth hook in UI | NavUser shows hardcoded user info |

### Task List

#### Pipeline Fix (blockers)

| Task | Description | File | Size |
|------|-------------|------|------|
| 0.1 | CommandLayer: catch `LinchKitError`, propagate code/message/details to ActionResult | `packages/core/src/engine/command-layer.ts` L326-347 | S |
| 0.2 | Server: map auth error codes to HTTP status (auth.* → 401, authz.* → 403) | `cap-adapter-server/src/server.ts` | S |

#### Config Layer

| Task | Description | File | Size |
|------|-------------|------|------|
| 0.3 | Replace `capAuth` with `createCapAuth({ provider: createDevAuthProvider() })` | `linchkit.config.ts` | S |
| 0.4 | Create `createCapPermission` factory (inject PermissionRegistry + middleware) | `cap-permission/src/factory.ts` (new) | M |
| 0.5 | Use `createCapPermission` in config with dev permission groups | `linchkit.config.ts` | S |
| 0.6 | Fix ANONYMOUS_ACTOR: `groups: []` instead of `["admin"]` | `cap-adapter-server/src/server.ts` | S |

#### UI Integration

| Task | Description | File | Size |
|------|-------------|------|------|
| 0.7 | Create `useAuth()` hook + AuthContext (decode token → user info) | `cap-adapter-ui-react/src/hooks/use-auth.tsx` (new) | M |
| 0.8 | NavUser reads from `useAuth()` instead of hardcoded props | `cap-adapter-ui-react/src/components/nav-user.tsx` | S |
| 0.9 | Fix `loginWithPassword` error swallowing (propagate to UI) | `cap-adapter-ui-react/src/lib/auth-client.ts` | S |
| 0.10 | API 401 interceptor: clear token + redirect to `/login` | `cap-adapter-ui-react/src/lib/api.ts` | S |

#### Tests

| Task | Description | File | Size |
|------|-------------|------|------|
| 0.11 | CommandLayer auth/permission integration test (anon→401, no-perm→403, valid→200) | `core/__tests__/command-layer-auth.test.ts` (new) | M |
| 0.12 | Permission factory unit test | `cap-permission/__tests__/factory.test.ts` (new) | S |

**Execution order:** 0.1 → 0.2 → 0.3 → 0.4 → 0.5 → 0.6 → 0.9 → 0.10 → 0.7 → 0.8 → 0.11 → 0.12

**Deferred to M1:**
- cap-auth-better-auth (DevAuthProvider sufficient for M0b)
- OAuth2/OIDC
- Register action (UI page exists, backend action missing)
- API Key lifecycle management
- Row-level security query filtering

---

## M1a: Data Persistence + Flow Engine

### Stage 1 — Drizzle ORM Infrastructure (blocks everything)

| Task | Description | New/Modify | Size | Dep |
|------|-------------|------------|------|-----|
| 1.1 | Database connection manager: `createDatabase(config)` using `postgres` (postgres.js) driver | `core/src/engine/database.ts` (new) | S | — |
| 1.2 | `DrizzleDataProvider` implementing `DataProvider` interface (5 methods + optimistic locking) | `core/src/engine/drizzle-data-provider.ts` (new) | M | 1.1 |
| 1.3 | System tables definition (executions, events, approvals, outbox) in `_linchkit` PostgreSQL schema (`pgSchema("_linchkit")`) | `core/src/engine/system-tables.ts` (new) | S | 1.1 |
| 1.4 | `DrizzleExecutionLogger` implementing `ExecutionLogger` interface | `core/src/engine/drizzle-execution-logger.ts` (new) | M | 1.1, 1.3 |
| 1.5 | `DrizzleApprovalStore` implementing `ApprovalStore` interface | `core/src/engine/drizzle-approval-store.ts` (new) | M | 1.1, 1.3 |
| 1.6 | `TableRegistry`: schema name → Drizzle table mapping, auto-build from SchemaRegistry | `core/src/engine/table-registry.ts` (new) | M | 1.2 |

**Architecture decisions:**
- **Database**: PostgreSQL only (JSONB, partitioning, Outbox all depend on PG)
- **Driver**: `postgres` (postgres.js) — best Bun compatibility, Drizzle recommended
- **System table namespace**: `_linchkit` PostgreSQL schema (via `pgSchema("_linchkit")`) to avoid business table conflicts

### Stage 2 — Migration System

| Task | Description | New/Modify | Size | Dep |
|------|-------------|------------|------|-----|
| 2.1 | Dev mode auto-sync: collect SchemaDefinitions → `drizzle-kit generate` + `migrate()` on startup | `cli/src/commands/dev.ts` (modify) | M | Stage 1 |
| 2.2 | Dynamic drizzle config: generate `.generated/schema.ts` from SchemaDefinitions for drizzle-kit | Script or utility | S | 2.1 |

**Dev mode**: `drizzle-kit generate` → `migrate()` from `drizzle-orm/postgres-js/migrator` (dev can reset: drop DB + delete migrations + regenerate)
**Production mode**: `drizzle-kit generate` → migration SQL → `migrate()` (append-only, never delete applied migrations)
**Note**: `drizzle-kit push` (`pushSchema()` API) has a known bug in Bun (hangs during introspection), so `migrate()` is used for both environments.

### Stage 3 — RuntimeContext Switch

| Task | Description | New/Modify | Size | Dep |
|------|-------------|------------|------|-----|
| 3.1 | RuntimeContext: `database.url` → Drizzle providers; no URL → InMemoryStore (backward compat) | `cap-adapter-server/src/runtime-context.ts` | M | Stage 1 |
| 3.2 | Integration tests with real PostgreSQL (CRUD, optimistic lock, system fields, GraphQL) | Multiple test files + `docker-compose.yml` | L | 3.1 |

### Stage 4 — Event Persistence + Outbox

| Task | Description | New/Modify | Size | Dep |
|------|-------------|------------|------|-----|
| 4.1 | Events table in `system-tables.ts` (per spec 07 schema) | `core/src/engine/system-tables.ts` (modify) | S | 1.3 |
| 4.2 | EventBus persistence: `emit()` writes to events table (simple mode, not in Action txn) | `core/src/engine/event-bus.ts` (modify) | M | 4.1 |
| 4.3 | OutboxWorker: poll → execute EventHandler → retry with exponential backoff | `core/src/engine/outbox-worker.ts` (new) | L | 4.1, 4.2 |

**M1a simplification**: Events and business data NOT in same transaction yet. Full transactional integration deferred to M1b.

### Stage 5 — Flow Engine

| Task | Description | New/Modify | Size | Dep |
|------|-------------|------------|------|-----|
| 5.1 | `FlowDefinition` types: trigger, steps (action/approval/wait), branches | `core/src/types/flow.ts` (new) | S | — |
| 5.2 | Restate infrastructure: SDK setup + service endpoint registration | `core/src/engine/flow/restate-service.ts` (new) | M | — |
| 5.3 | FlowDefinition → Restate workflow compiler: compile steps into Restate virtual object handlers | `core/src/engine/flow/flow-compiler.ts` (new) | L | 5.1, 5.2 |
| 5.4 | FlowRegistry + trigger binding (listen to `action.succeeded` events) | `core/src/engine/flow/flow-registry.ts` (new) | M | 5.3 |

**Runtime: Restate** — single Rust binary, no external dependencies, Bun officially supported.
- SDK: `@restatedev/restate-sdk` (v1.11.1)
- Docker: `docker.restate.dev/restatedev/restate:latest` (ports: 8080 ingress, 9070 admin + Web UI)
- Dual mode: with Restate server = full durable Flow execution; without = simple sync Flow fallback
- Temporal explicitly NOT chosen (too heavy: requires Go server + Cassandra/PG backend)

### M1a Dependency Graph

```
Stage 1 (Drizzle)           Stage 5 (Flow)
  1.1 ─┬─ 1.2 ─── 1.6        5.1 ──┐
       ├─ 1.3 ─┬─ 1.4        5.2 ──┼── 5.3 ── 5.4
       │       └─ 1.5               │
       │                            │
Stage 2 (Migration)                 │
  Stage1 ── 2.1 ── 2.2             │
                                    │
Stage 3 (Integration)              │
  Stage1 ── 3.1 ── 3.2            │
                                   │
Stage 4 (Events)                   │
  1.3 ── 4.1 ── 4.2 ── 4.3       │
```

### M1a Complexity Summary

| Task | Size | Est. Days |
|------|------|-----------|
| 1.1 DB connection | S | 0.5 |
| 1.2 DrizzleDataProvider | M | 1.5 |
| 1.3 System tables | S | 0.5 |
| 1.4 DrizzleExecutionLogger | M | 1 |
| 1.5 DrizzleApprovalStore | M | 1 |
| 1.6 TableRegistry | M | 1 |
| 2.1 Auto-sync | M | 1 |
| 2.2 Dynamic config | S | 0.5 |
| 3.1 RuntimeContext switch | M | 1 |
| 3.2 Integration tests | L | 2 |
| 4.1 Events table | S | 0.5 |
| 4.2 EventBus persistence | M | 1 |
| 4.3 OutboxWorker | L | 2 |
| 5.1 Flow types | S | 0.5 |
| 5.2 Restate infra | M | 1 |
| 5.3 Flow compiler | L | 3 |
| 5.4 FlowRegistry | M | 1 |
| **Total** | | **~19 days** |

---

## M1b: Ecosystem Extension + AI Integration

### Phase 1 — MCP Adapter Complete Implementation

| Task | Description | Size | Dep |
|------|-------------|------|-----|
| 1.1 | MCP Transport Factory: wire `createMcpAdapter()` with stdio transport | S | — |
| 1.2 | MCP Bearer Token auth (env var for stdio, HTTP header for SSE) | S | — |
| 1.3 | Enhanced MCP tools: `list_capabilities`, `get_rules`, `get_state_machine`, `create_proposal`, `query` (GraphQL proxy) | M | 1.1 |
| 1.4 | MCP SSE Transport via Elysia route | M | 1.1 |

**Architecture decision**: Extend `TransportContext` to include all registries (schemaRegistry, actionRegistry, etc.) — MCP introspection tools need direct registry access.

### Phase 2 — Flow Engine AI Integration

| Task | Description | Size | Dep |
|------|-------------|------|-----|
| 2.1 | Flow type definitions (including `AIStep` with model/prompt/tools/responseFormat) | M | — |
| 2.2 | FlowEngine with Restate (durable execution) + sync fallback (no Restate server) | L | 2.1 |
| 2.3 | AI Step tool calling: Action → Vercel AI SDK tool format, multi-turn execution | M | 2.2 |

**Architecture decision**: M1b implements FlowEngine backed by Restate for durable execution. Without Restate server, falls back to simple sync execution. `defineFlow` DSL stays the same regardless of runtime mode.

### Phase 3 — AI Proposal Assistance

| Task | Description | Size | Dep |
|------|-------------|------|-----|
| 3.1 | AI Proposal Generator: natural language → Schema/Action/Rule changes via `ctx.ai.complete()` | L | — |
| 3.2 | MCP scaffold tools: `scaffold_capability`, `scaffold_rule`, `scaffold_action` | M | 1.3, 3.1 |

**Architecture decision**: All AI-generated Proposals MUST go through validate → approve flow. M1b forces `changeType: 'minor'` (human approval required).

### Phase 4 — Ecosystem Infrastructure

| Task | Description | Size | Dep |
|------|-------------|------|-----|
| 4.1 | CLI `linch create capability` (interactive scaffold with template selection) | M | — |
| 4.2 | CLI `linch install` (bun add + capability metadata validation + dependency resolution) | M | 4.3 |
| 4.3 | `capability.json` metadata schema (Zod validation) | S | — |
| 4.4 | Devtools: `createTestRuntime()`, `createTestActor()`, `mockAIService()` | S | — |

### Phase 5 — Full-stack i18n (Backend Data Layer)

| Task | Description | Size | Dep |
|------|-------------|------|-----|
| 5.1 | `BaseFieldDefinition.translatable?: boolean` + `SchemaDefinition.i18n` config | S | — |
| 5.2 | Schema-to-Drizzle: translatable fields → JSONB column generation | M | 5.1 |
| 5.3 | Action Engine: translatable value read/write (locale resolution + fallback chain) | M | 5.2 |
| 5.4 | GraphQL: `_i18n` field type + `locale` query parameter for translatable fields | M | 5.3 |

**Architecture decision**: M1b only implements backend data-layer i18n. Frontend translatable field widgets deferred to M2.

### M1b Implementation Batches

**Batch 1 (parallel, ~1-2 weeks):**
- Task 1.1 MCP Transport wiring [S]
- Task 2.1 Flow types [M]
- Task 4.3 capability.json schema [S]
- Task 5.1 translatable field type [S]

**Batch 2 (depends on batch 1, ~2-3 weeks):**
- Task 1.2 MCP auth [S]
- Task 1.3 MCP enhanced tools [M]
- Task 2.2 Flow Engine lightweight [L]
- Task 5.2 translatable JSONB [M]
- Task 5.3 TranslatableValue read/write [M]

**Batch 3 (depends on batch 2, ~2-3 weeks):**
- Task 2.3 AI Step tool calling [M]
- Task 3.1 AI Proposal Generator [L]
- Task 4.1 CLI create capability [M]
- Task 4.2 CLI install [M]
- Task 5.4 GraphQL i18n [M]

**Batch 4 (finishing, ~1 week):**
- Task 1.4 MCP SSE Transport [M]
- Task 3.2 MCP scaffold tools [M]
- Task 4.4 Devtools enhancements [S]

---

## Key Architecture Decisions Summary

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | PostgreSQL only | Spec 00 mandate; JSONB, partitioning, Outbox all require PG |
| 2 | `postgres` (postgres.js) driver | Best Bun compatibility, Drizzle recommended |
| 3 | System table namespace `_linchkit` PostgreSQL schema | Avoid business table name collisions (via `pgSchema("_linchkit")`) |
| 4 | Dev and prod both use `migrate()` API | `pushSchema()` has a known Bun bug; dev can reset DB + migrations, prod is append-only |
| 5 | Restate for Flow Engine | Single Rust binary, Bun officially supported, no external deps |
| 6 | M1a: no cross-operation transactions | Each DB operation has own transaction; full txn integration in M1b |
| 7 | TransportContext expands to full registry access | MCP tools need direct schema/action/rule introspection |
| 8 | Flow: Restate durable execution + sync fallback | FlowDefinition DSL compiles to Restate workflows; sync fallback when no Restate server |
| 9 | AI Proposals require human approval | Security: AI cannot auto-commit changes to production |
| 10 | i18n: backend data layer only in M1b | Frontend widgets deferred to M2 |

## Risk Matrix

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Restate server unavailable in prod | Durable Flow unavailable | Low | Dual-mode: sync fallback executes flows without durability; Restate is a single binary with no external deps |
| Drizzle dynamic table TypeScript issues | DrizzleDataProvider dev friction | Low | Use `any` bridge, runtime safety via SchemaDefinition |
| PostgreSQL adds DX complexity | Slower onboarding | Low | `docker-compose.yml`; InMemory mode preserved for prototyping |
| MCP SDK breaking changes | Adapter rework | Low | Pin SDK version; SSE as optional transport |
