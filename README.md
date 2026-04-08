# LinchKit

> **AI-Native Software Capability Runtime.** Any software system driven by data, rules, and state can grow incrementally through AI-human collaboration, running safely and evolving continuously under a unified governance system.

[中文文档](./README.zh-CN.md)

---

## What is LinchKit?

LinchKit is a framework where you **define** your software system declaratively (entities, actions, rules, states, events, views, flows, relations), and the runtime takes care of the rest: API generation, UI rendering, state management, event handling, and governance.

AI agents (Claude Code, Cursor, Codex, Copilot, Trae) work alongside humans to design and generate complete capabilities. The framework provides guardrails: all writes go through Actions, all changes go through Proposals, and quality gates enforce standards before anything ships.

### Core Principles

1. **Unified Meta-Model** — Entity + Action + Rule + State + Event + EventHandler + View + Flow + Relation
2. **AI Deep Participation** — Design, generate, optimize — but never modify production directly
3. **Capability-Centric** — Everything is a Capability (business, system, adapter). No "plugin" concept.
4. **Single Write Entry** — All mutations flow through Actions. GraphQL handles reads only.
5. **Change Governance** — Proposal → Validation → Approval → Apply
6. **Infinite Extensibility** — New protocols, field types, view types, services all register via Capability extensions

### Use Cases

E-commerce, SaaS, project management, CMS, ERP, booking systems, IoT management — any software where the core is data + rules + state.

Not suitable for: compute-intensive, real-time, or low-level systems.

---

## Quick Start

```bash
# Install CLI
bun add -g @linchkit/cli

# Scaffold a new project (generates AI tool configs for Claude Code, Cursor, etc.)
linch init my-project --ai-tools claude-code,cursor

cd my-project
bun install
linch dev
```

### AI-Guided Setup

After `linch init`, open the project in your AI coding tool:

- **Claude Code**: type `/skill linch:bootstrap`
- **Cursor / Codex / Trae / Copilot**: paste "I just created this LinchKit project. Help me set it up: ask what I want to build, recommend and install capabilities, then help me define entities, actions, and rules."

The AI agent will interactively guide you through capability selection, entity design, and action design.

`linch init` generates:
- `linchkit.config.ts` — Project configuration
- `AGENTS.md` / `CLAUDE.md` — AI development instructions
- `.mcp.json` — MCP dev server config for AI tools
- `.claude/skills/linch/` — development skills (entity design, action design, etc.)
- `.cursor/rules/linch/` — Same skills for Cursor

---

## Tech Stack

| Layer | Choice |
|-------|--------|
| Language | TypeScript (strict mode) |
| Runtime | Bun |
| Backend | Elysia |
| Database | PostgreSQL |
| ORM | Drizzle |
| GraphQL | graphql-yoga + graphql-js (code-first) |
| Flow Engine | Restate (durable execution, dual-mode) |
| Frontend | React 19 + Vite + TanStack Router |
| UI | Shadcn + Radix + Lucide + Tailwind |
| Code Quality | Biome + TypeScript strict |

---

## Architecture

```
                    ┌─────────────────────────────┐
                    │         Entry Layer          │
                    │  CLI / MCP / HTTP API / UI   │
                    └──────────┬──────────────────┘
                               │
                    ┌──────────▼──────────────────┐
                    │       Command Layer          │
                    │  pre → auth → exposure →     │
                    │  permission → tenant →       │
                    │  pre-action → post-action    │
                    └──────────┬──────────────────┘
                               │
          ┌────────────────────┼────────────────────┐
          │                    │                     │
   ┌──────▼──────┐    ┌───────▼─────┐    ┌─────────▼────┐
   │   Action    │    │  GraphQL    │    │   Proposal   │
   │   Engine    │    │  (read)     │    │   Engine     │
   │   (write)   │    │             │    │  (governance)│
   └──────┬──────┘    └─────────────┘    └──────────────┘
          │
   ┌──────▼──────┐
   │ Rule Engine │ ← Trigger + Context + Condition + Effect
   └──────┬──────┘
          │
   ┌──────▼──────┐    ┌──────────────┐    ┌──────────────┐
   │   State     │    │  Event Bus   │    │   Restate    │
   │  Machine    │    │  + Outbox    │    │   (Flow)     │
   └─────────────┘    └──────┬───────┘    └──────────────┘
                             │
                    ┌────────▼─────────┐
                    │  EventHandler    │
                    │  (sync + async)  │
                    └────────┬─────────┘
                             │
                    ┌────────▼─────────┐
                    │   PostgreSQL     │
                    │  data + events   │
                    │  + outbox + logs │
                    └──────────────────┘
```

---

## Meta-Model

Everything in LinchKit is defined declaratively:

```typescript
import { defineEntity, defineAction, defineRule, defineState, defineRelation } from "@linchkit/core";

// Entity — data structure with fields and validations
const order = defineEntity({
  name: "order",
  label: "Order",
  fields: {
    customer_name: { type: "string", required: true },
    total: { type: "number", min: 0 },
    status: { type: "state" },
  },
});

// Action — sole write entry point (verb_noun naming)
const submit_order = defineAction({
  name: "submit_order",
  entity: "order",
  label: "Submit Order",
  stateTransition: { from: "draft", to: "pending" },
  policy: { requiresAuth: true },
});

// Rule — declarative conditions + effects
const block_large_order = defineRule({
  name: "block_large_order",
  trigger: { type: "action", action: "submit_order" },
  condition: { field: "total", operator: "gt", value: 10000 },
  effect: { type: "require_approval" },
});

// Relation — first-class entity relationships
const order_items = defineRelation({
  name: "order_items",
  from: "order",
  to: "order_item",
  cardinality: "one_to_many",
});
```

| Concept | Purpose | Define Function |
|---------|---------|-----------------|
| **Entity** | Data structure with fields, validations, system fields | `defineEntity()` |
| **Action** | Sole write entry point. Named `verb_noun` | `defineAction()` |
| **Rule** | Declarative conditions + effects | `defineRule()` |
| **State** | Finite state machine per entity instance | `defineState()` |
| **Event** | Domain events emitted by actions/state transitions | `defineEvent()` |
| **EventHandler** | Sync/async reactions to events | `defineEventHandler()` |
| **View** | UI rendering config (list, form, kanban) | `defineView()` |
| **Flow** | Multi-step durable workflows (Restate dual-mode) | `defineFlow()` |
| **Relation** | First-class relationships between entities | `defineRelation()` |

---

## Capability System

Everything in LinchKit is a **Capability**: business modules, protocol adapters, and cross-module connectors.

```typescript
import { defineCapability } from "@linchkit/core";

export default defineCapability({
  name: "my-feature",
  type: "standard",
  entities: [order],
  actions: [submit_order],
  rules: [block_large_order],
  relations: [order_items],
});
```

**Capability Types:**
- `standard` — Business modules (e-commerce, CRM, etc.)
- `adapter` — Protocol transports (HTTP/GraphQL, MCP, A2A, AG-UI)
- `bridge` — Cross-module connectors

**Extension Points:**

| Extension | Purpose | Example |
|-----------|---------|---------|
| `fieldTypes` | Custom field types | money, file, address |
| `viewTypes` | Custom view types | map, gantt, timeline |
| `ruleEffects` | Custom rule effects | send_sms, create_ticket |
| `services` | Injectable services | storage, search |
| `hooks` | Lifecycle hooks | system.start, action.before |
| `middlewares` | Command Layer middleware | auth, rate-limit |
| `transports` | Protocol adapters | MCP, A2A, AG-UI |

---

## Packages

```
packages/ (core infrastructure — published to npm):
  @linchkit/core                  — Types, engines, pipeline
  @linchkit/cli                   — CLI (linch init, dev, doctor, etc.)
  @linchkit/devtools              — Test utilities

addons/ (grouped capabilities — OCA model):
  adapter-server/
    @linchkit/cap-adapter-server  — Elysia + graphql-yoga + REST + CommandLayer
  adapter-ui/
    @linchkit/cap-adapter-ui      — React 19 + Shadcn + TanStack (official UI)
  adapter-mcp/
    @linchkit/cap-adapter-mcp     — MCP transport for AI agents
    @linchkit/cap-mcp-ui          — MCP UI components
  chatter/
    @linchkit/cap-chatter         — Timeline: messages, audit log, GraphQL
    @linchkit/cap-chatter-ui      — Chatter React UI panel
  auth/
    @linchkit/cap-auth            — Authentication (JWT, sessions)
    @linchkit/cap-auth-better-auth — Auth provider (Better Auth)
  permission/
    @linchkit/cap-permission      — Permission engine (RBAC)
  ai-provider/
    @linchkit/cap-ai-provider     — AI SDK (Anthropic, OpenAI, custom)
  flow-restate/
    @linchkit/cap-flow-restate    — Restate durable execution
  migration/
    @linchkit/cap-migration       — Database migration tooling
  demo/
    @linchkit/cap-purchase-demo   — Demo: purchase management scenario
```

---

## Capability Catalog

Official capabilities available via `linch install`:

| Capability | Type | Category | Description |
|-----------|------|----------|-------------|
| `@linchkit/cap-adapter-server` | adapter | transport | HTTP/GraphQL server (Elysia + graphql-yoga) |
| `@linchkit/cap-adapter-ui` | adapter | transport | Official React UI (Shadcn + TanStack) |
| `@linchkit/cap-adapter-mcp` | adapter | transport | MCP transport for AI agents |
| `@linchkit/cap-auth` | standard | auth | Authentication (JWT, sessions) |
| `@linchkit/cap-auth-better-auth` | standard | auth | Auth provider (Better Auth) |
| `@linchkit/cap-permission` | standard | auth | Permission engine (RBAC) |
| `@linchkit/cap-chatter` | standard | collaboration | Timeline: messages, audit log |
| `@linchkit/cap-ai-provider` | standard | ai | AI SDK (Anthropic, OpenAI) |
| `@linchkit/cap-flow-restate` | standard | workflow | Restate durable execution |
| `@linchkit/cap-migration` | standard | infrastructure | Database migration tooling |

Third-party capabilities can be contributed via PR to the capability registry.

---

## Key Features

### Runtime Entity Overlay
Add custom fields to entities at runtime without code changes. Overlay fields are stored in a `_extensions` JSONB column, rendered in UI forms and lists, and can be "promoted" to permanent code when stable.

### AI Development Workflow
Three modes of AI-assisted development:
- **Local Agent Development** — AI tools develop locally, then git → PR → merge
- **Runtime Overlay** — Additive field changes via ProposalEngine → JSONB (no git)
- **AI Self-Evolution** — Life System signals → PatternDetector → Proposal → code generation → PR

### MCP Dev Server
`linch mcp-dev` starts an MCP server exposing project introspection to AI tools:
- Discovery tools — list/describe entities, actions, relations, capabilities
- Validation tools — validate proposed definitions before writing code
- Dynamic prompts — project-aware guidance for capability development

### Auto-Generated UI
Schema-driven UI components:
- **AutoForm** — Entity-driven forms with validation, state transitions, overlay fields
- **AutoList** — TanStack Table with sorting, filtering, pagination, overlay columns
- **Admin Dashboards** — Execution logs, metrics, relation graph visualization

### Observability
- Alert engine with conditions and effects
- Metrics collector for request/response tracking
- Structured logging (Pino-based) with log sinks
- Execution log dashboard with full audit trail

### Governance
- Approval engine with create/approve/reject/expire lifecycle
- Proposal engine with validation and governance workflow
- ProposalCodeGenerator for AI-assisted code generation with quality gates

---

## CLI Commands

```bash
linch init <name>       # Scaffold a new project
linch dev               # Start dev server (server + UI)
linch mcp-dev           # Start MCP dev server for AI tools
linch doctor            # Run health checks
linch validate          # Validate definitions
linch agents-md         # Auto-generate AGENTS.md
linch info              # Project introspection
linch db generate       # Generate migration SQL
linch db migrate        # Apply pending migrations
linch db studio         # Open Drizzle Studio
linch overlay promote   # Graduate overlay fields to code
linch create            # Scaffold new capabilities/entities/actions
linch publish           # Publish packages
```

---

## Development

```bash
# Prerequisites: Bun, PostgreSQL, Docker (optional, for Restate)

# Start infrastructure
docker compose up -d    # PostgreSQL + Restate

bun install             # Install dependencies
bun test                # Run tests
bun run dev             # Start dev server (server :3001 + UI :3000)
bun run dev:server      # Server only
bun run dev:ui          # UI only (proxies API to :3001)
bun run check           # Biome lint + format
bun run typecheck       # TypeScript type check

# Database management
bun run db:generate     # Generate migration SQL from schema changes
bun run db:migrate      # Apply pending migrations
bun run db:studio       # Open Drizzle Studio GUI
```

## License

MIT
