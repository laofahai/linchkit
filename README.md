# LinchKit

> **AI-Native Software Capability Runtime.** Any software system driven by data, rules, and state can grow incrementally on this framework through AI-human collaboration, running safely and evolving continuously under a unified governance system.

[中文文档](./README.zh-CN.md)

---

## Core Principles

1. **Unified Meta-Model** — Schema + Action + Rule + State + Event + EventHandler + View + Flow + Link
2. **AI Deep Participation** — Design, generate, optimize — but never modify production directly
3. **Modular Organization** — Capability (standard / bridge / adapter), independently evolvable, composable on demand
4. **Unified Entry Point** — Command Layer unifies CLI / MCP / API / UI; Action is the sole write entry, GraphQL for reads
5. **Change Governance** — Proposal → GitHub PR → CI → Approval → Blue-Green Deploy
6. **Methodology-Driven** — Framework-level conventions + business-level knowledge; AI follows SOPs to generate code

## Use Cases

E-commerce, SaaS, project management, CMS, ERP, booking systems, IoT management — any software where the core is data + rules + state.

Not suitable for: compute-intensive, real-time, or low-level systems.

---

## Tech Stack

| Layer | Choice |
|-------|--------|
| Language | TypeScript |
| Runtime | Bun (not Node-compatible) |
| Backend | Elysia |
| Database | PostgreSQL |
| ORM | Drizzle |
| GraphQL | graphql-yoga + graphql-js (code-first) |
| State Machine | Custom pure TS (XState as optional upgrade) |
| Flow Engine | Restate (`@restatedev/restate-sdk` v1.11.1) — durable execution, dual-mode |
| Frontend | React + Vite + TanStack Router |
| UI | Shadcn + Lucide + Tailwind |
| Code Quality | Biome + TypeScript strict |

---

## Packages

```
packages/ (core infrastructure):
  @linchkit/core       — Types, engines, pipeline
  @linchkit/cli        — CLI launcher (citty)
  @linchkit/devtools   — Test utilities

capabilities/ (pluggable):
  @linchkit/cap-adapter-server    — HTTP/GraphQL transport (Elysia + graphql-yoga)
  @linchkit/cap-adapter-mcp       — MCP transport for AI agents
  @linchkit/cap-adapter-ui-react  — Official UI shell (React + Shadcn + TanStack)
  @linchkit/cap-auth              — Authentication (JWT, sessions)
  @linchkit/cap-auth-better-auth  — Auth provider (Better Auth)
  @linchkit/cap-permission        — Permission engine (RBAC)
  @linchkit/cap-purchase-demo     — Demo: purchase management scenario
```

---

## Milestones

### M0a — Dev Infrastructure + UI Shell

**Goal:** Set up AI-assisted dev environment + management UI skeleton.

**Acceptance:** AI has full type definitions and CLAUDE.md. Browser shows LinchKit management UI shell.

- [x] Monorepo skeleton (Bun workspace)
- [x] tsconfig strict + biome.json + Git hooks
- [x] Full type definitions (defineXxx interfaces, no implementation)
- [x] CLAUDE.md first version
- [x] Basic CLI (linch init + linch dev)
- [x] Bun test + first test
- [x] GitHub Actions basic CI
- [x] App Shell UI (header + sidebar + main content + login placeholder)

*M0a complete.*

---

### M0b — Core Runtime (UI syncs with each engine)

**Goal:** Build core engines with AI assistance, UI follows engine progress. Purchase management scenario end-to-end.

**Acceptance:** Browser shows complete purchase management UI — list, form, state transitions, action buttons, logs. Rule blocks over-budget requests.

*(Core engines + Approval + Proposal + AI Service complete. Auth/permission remaining.)*

- [x] Schema Engine — Registry + Zod generator + Drizzle generator + GraphQL type generator
- [x] Action Engine — ActionRegistry + ActionExecutor (permission, validation, state transition, handler execution)
- [x] Rule Engine (Level 1-2) core
- [x] State Machine core
- [x] Event Bus — EventHandlerRegistry + EventBus (sync/async dispatch, filter, priority)
- [x] Command Layer — slot-based middleware pipeline (pre/auth/exposure/permission/tenant/pre-action/post-action) *(370 tests passing)*
- [x] API + GraphQL server — REST action endpoint + GraphQL queries/mutations + typed custom action mutations
- [x] Auto-generated business UI — AutoList + AutoForm + FieldRenderer *(Schema-driven, demo with purchase_request)*
- [x] App Shell UI upgrade — Odoo-style form, TanStack Table list, i18n (en/zh-CN), Shadcn sidebar
- [x] Header toolbar — Command Palette (⌘K), theme toggle, language switcher, notification placeholder
- [x] Execution Log — REST + GraphQL query API, Dashboard UI (/admin/executions), tenant_id support
- [x] CLAUDE.md upgrade — full engine API docs, server endpoints, UI architecture, error types
- [x] E2E test — 16 tests covering complete purchase management flow (create → submit → approve → error → log)
- [x] Business Approval Engine — Create/approve/reject/expire + Rule Engine integration (33 tests)
- [x] Proposal + Validation Engine — Change governance lifecycle + Phase 1 static validation (64 tests)
- [x] AI Service (ctx.ai) — Vercel AI SDK wrapper, Anthropic/OpenAI/custom endpoint support (25 tests)
- [x] Config loading — .env → linchkit.config.ts → resolveEnvVars → RuntimeContext
- [ ] cap-auth + cap-permission + login + access control

**Not in scope:** blue-green deploy, Bridge / Adapter, full multi-tenancy, notifications / scheduled tasks.

---

### M1 — Governance + Deployment

**Goal:** Changes go through Proposal → GitHub PR → CI → Approval → Blue-Green Deploy.

- [x] Proposal model + Validation *(Core engines built in M0b; M1 adds GitHub PR integration + deploy workflow)*
- [ ] Version management (Git tag, diff, rollback)
- [x] Approval mechanism *(Core engines built in M0b; M1 adds GitHub PR integration + deploy workflow)*
- [ ] Single-node blue-green deploy + Nginx
- [ ] GitHub integration (PR + CI + Webhook)
- [ ] DB Migration (up + down)
- [x] Restate Flow Engine (dual-mode: durable + sync fallback)
- [ ] Bridge module support
- [ ] Full CI Pipeline + AI Review

---

### M2 — Link Type + OntologyRegistry + GraphQL Subscriptions

**Goal:** First-class relationships, semantic registry, real-time subscriptions, schema advanced features.

- [x] MCP adapter *(implemented in M1b)*
- [x] Full CLAUDE.md + AGENTS.md *(maintained throughout)*
- [x] AI-assisted Proposal generation *(implemented in M1b)*
- [x] OntologyRegistry — unified semantic layer across all registries
- [x] Link Type — `defineLink()` with bidirectional navigation, FK/junction table generation, GraphQL resolvers
- [x] GraphQL Subscriptions — SSE-based real-time event streaming
- [x] DataLoader integration — N+1 query optimization for link resolvers
- [x] Schema Interface — `defineSchemaInterface()` reusable field contracts
- [x] Schema Inheritance — single-parent field/action/rule/state inheritance
- [x] Derived Properties — computed fields evaluated at query time
- [x] Reactive Automation — event-driven trigger bindings
- [x] Soft Delete — logical deletion with restore/purge
- [x] Data Masking — field-level masking rules + UI masked display
- [x] Tenant API + UI Switcher — `/api/tenants` endpoint, tenant switcher in header
- [x] Pagination enhancements — cursor-based pagination in GraphQL
- [ ] AI Skills package
- [ ] Rule Context Level 3-4
- [ ] Full multi-tenancy (Standalone + SaaS dual mode)
- [ ] AI security (rate limiting + permissions + audit)

---

### M3 — System Can "Grow"

**Goal:** AI assists in designing and generating complete Capabilities.

- [ ] AI generates full Capabilities
- [ ] Rule Context Level 5 (cross-module)
- [ ] Evolution System (Observe → Propose)
- [ ] Flow AI steps + conditional branches + parallel
- [ ] Capability Hub basics

---

### M4 — Production Grade

- [ ] Full multi-tenancy (Schema/DB isolation, billing)
- [ ] Multi-node Rolling Update
- [ ] OpenTelemetry integration
- [ ] Legacy system migration tools
- [ ] Capability Hub marketplace

---

## Architecture Overview

```
                    ┌─────────────────────────────┐
                    │         Entry Layer          │
                    │  CLI / MCP / HTTP API / UI   │
                    └──────────┬──────────────────┘
                               ↓
                    ┌─────────────────────────────┐
                    │      Command Layer           │
                    │  slot: pre → auth →          │
                    │  exposure → permission →     │
                    │  tenant → pre-action         │
                    └──────────┬──────────────────┘
                               ↓
          ┌────────────────────┼────────────────────┐
          ↓                    ↓                     ↓
   ┌─────────────┐    ┌──────────────┐    ┌──────────────┐
   │ Action      │    │ GraphQL      │    │ Proposal     │
   │ Engine      │    │ Query Engine │    │ Engine       │
   │ (write)     │    │ (read)       │    │ (governance) │
   └──────┬──────┘    └──────────────┘    └──────────────┘
          ↓
   ┌─────────────┐
   │ Rule Engine │ ← Trigger + Context + Condition + Effect
   └──────┬──────┘
          ↓
   ┌─────────────┐    ┌──────────────┐    ┌──────────────┐
   │ State       │    │ Event Bus    │    │ Restate      │
   │ Machine     │    │ + Outbox     │    │ (Flow)       │
   └─────────────┘    └──────┬───────┘    └──────────────┘
                             ↓
                    ┌──────────────────┐
                    │  EventHandler    │
                    │  (sync + async)  │
                    └──────────────────┘
                             ↓
                    ┌──────────────────┐
                    │   PostgreSQL     │
                    │  data + events   │
                    │  + outbox + log  │
                    └──────────────────┘
```

---

## Development

```bash
# Start infrastructure (PostgreSQL + Restate)
docker compose up -d

bun install          # Install dependencies
bun test             # Run tests
bun run dev          # Start dev server (server :3001 + UI :3000)
bun run dev:server   # Server only on :3001
bun run dev:ui       # UI only on :3000 (proxies API to :3001)
bun run check        # Biome lint + format check
bun run typecheck    # TypeScript type check

# Database management
bun run db:generate  # Generate migration SQL from schema changes
bun run db:migrate   # Apply pending migrations
bun run db:studio    # Open Drizzle Studio GUI
```

`docker-compose.yml` provides: PostgreSQL 16 (dev on :5432, test on :5434) + Restate (ingress :8080, admin :9070).

## License

MIT
