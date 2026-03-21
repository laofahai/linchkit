# LinchKit

> **AI-Native Software Capability Runtime.** Any software system driven by data, rules, and state can grow incrementally on this framework through AI-human collaboration, running safely and evolving continuously under a unified governance system.

[中文文档](./README.zh-CN.md)

---

## Core Principles

1. **Unified Meta-Model** — Schema + Action + Rule + State + Event + EventHandler + View + Flow
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
| GraphQL | graphql-yoga + Pothos (code-first) |
| State Machine | Custom pure TS (XState as optional upgrade) |
| Workflow | Temporal (introduced in M1) |
| Frontend | React + Vite + TanStack Router |
| UI | Shadcn + Lucide + Tailwind |
| Code Quality | Biome + TypeScript strict |

---

## Packages

```
@linchkit/core       — Core runtime (Action/Rule/State/Event/Schema engine)
@linchkit/cli        — CLI tool (based on citty)
@linchkit/server     — HTTP server (Elysia + graphql-yoga + Pothos)
@linchkit/mcp        — MCP adapter (optional)
@linchkit/ui         — Frontend UI components + headless hooks
@linchkit/migrate    — Migration tools
@linchkit/devtools   — Test utilities + dev tools
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

*(Core engines complete, E2E verified. Auth/permission remaining.)*

- [x] Schema Engine — Registry + Zod generator + Drizzle generator + GraphQL type generator
- [x] Action Engine — ActionRegistry + ActionExecutor (permission, validation, state transition, handler execution)
- [x] Rule Engine (Level 1-2) core
- [x] State Machine core
- [x] Event Bus — EventHandlerRegistry + EventBus (sync/async dispatch, filter, priority)
- [x] ~~Command Layer +~~ API + GraphQL server — REST action endpoint + GraphQL queries/mutations + typed custom action mutations *(305 tests passing)*
- [x] Auto-generated business UI — AutoList + AutoForm + FieldRenderer *(Schema-driven, demo with purchase_request)*
- [x] App Shell UI upgrade — Odoo-style form, TanStack Table list, i18n (en/zh-CN), Shadcn sidebar
- [x] Header toolbar — Command Palette (⌘K), theme toggle, language switcher, notification placeholder
- [x] Execution Log — REST + GraphQL query API, Dashboard UI (/admin/executions), tenant_id support
- [x] CLAUDE.md upgrade — full engine API docs, server endpoints, UI architecture, error types
- [x] E2E test — 16 tests covering complete purchase management flow (create → submit → approve → error → log)
- [ ] cap-auth + cap-permission + pipeline slots + login + access control

**Not in scope:** Proposal / Validation / Version, blue-green deploy, Bridge / Adapter, AI / MCP, Temporal / Flow, full multi-tenancy, notifications / scheduled tasks.

---

### M1 — Governance + Deployment

**Goal:** Changes go through Proposal → GitHub PR → CI → Approval → Blue-Green Deploy.

- [ ] Proposal model + Validation
- [ ] Version management (Git tag, diff, rollback)
- [ ] Approval mechanism
- [ ] Single-node blue-green deploy + Nginx
- [ ] GitHub integration (PR + CI + Webhook)
- [ ] DB Migration (up + down)
- [ ] Temporal + defineFlow basics
- [ ] Bridge module support
- [ ] Full CI Pipeline + AI Review

---

### M2 — AI Integration + Multi-Tenancy

**Goal:** AI calls Actions via MCP, generates Proposals. Multi-tenancy basics.

- [ ] MCP adapter
- [ ] Full CLAUDE.md + AGENTS.md
- [ ] AI Skills package
- [ ] AI-assisted Proposal generation
- [ ] Rule Context Level 3-4
- [ ] Multi-tenancy (Standalone + SaaS dual mode)
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
   │ State       │    │ Event Bus    │    │ Temporal     │
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
bun install          # Install dependencies
bun test             # Run tests
bun run dev          # Start dev server
bun run check        # Biome lint + format check
bun run typecheck    # TypeScript type check
```

## License

MIT
