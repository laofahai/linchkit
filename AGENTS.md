# linchkit — Development Guide

## Overview

This project is built with **LinchKit**, an AI-Native Software Capability Runtime.

Meta-model: **Entity + Action + Rule + State + Event + EventHandler + View + Flow + Relation**

Key principle: All mutations flow through **Actions** — there is no direct CRUD.

## Execution Workflow

- **Execution source of truth:** GitHub milestones and issues
- **Specs:** Define target design and stable constraints
- **README:** Background and project introduction only, not a task source
- **Suggested startup order for AI agents:** read `CLAUDE.md` / `AGENTS.md`, then `docs/specs/INDEX.md`, then inspect current GitHub milestones and issues, then read only the relevant spec files
- **Rule:** If a spec exists for the area being changed, read it before implementation

## Tech Stack

| Layer | Stack |
|-------|-------|
| Runtime | Bun |
| Language | TypeScript (strict mode) |
| Backend | Elysia |
| GraphQL | graphql-yoga + graphql-js (code-first) |
| ORM | Drizzle (PostgreSQL) |
| Frontend | React 19 + Vite |
| Routing | TanStack Router |
| UI | Shadcn + Radix + Tailwind |
| Testing | bun run test |
| Code Quality | Biome |

## Entities

### `purchase_request` — Purchase Request

A purchase request submitted for approval

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | Yes | Title |
| `description` | text | No | Description |
| `amount` | number | Yes | Amount |
| `requester` | string | No | Requester |
| `requester_email` | string | Yes | Requester Email |
| `status` | state | No |  |
| `priority` | enum | No | Priority |
| `notes` | text | No | Notes |
| `audit_notes` | text | No | Audit Notes |
| `submitted_at` | datetime | No | Submitted At |
| `approved_at` | datetime | No | Approved At |
| `approved_by` | string | No | Approved By |
| `total_amount` | number | No | Total Amount |
| `display_title` | string | No | Display Title |

### `department` — Department

Organizational department that owns purchase requests

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Name |
| `code` | string | Yes | Code |
| `manager` | string | No | Manager |
| `budget_limit` | number | No | Budget Limit |

### `purchase_item` — Purchase Item

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Item Name |
| `quantity` | number | Yes | Quantity |
| `unit_price` | number | Yes | Unit Price |
| `specification` | text | No | Specification |
| `line_total` | number | No | Line Total |


## Actions

### purchase_request

- `submit_purchase_request` (Submit for Approval) — Submit a draft purchase request for approval Input: `notes`
- `approve_purchase_request` (Approve) — Approve a pending purchase request
- `reject_purchase_request` (Reject) — Reject a pending purchase request Input: `reason`


## Relations

- `purchase_request` → `department` (many_to_one) [department ↔ purchase_requests] — "Department"
- `purchase_request` → `purchase_item` (one_to_many) [items ↔ purchase_request] — "Items"


## State Machines

### purchase_request — `status`

- **States:** draft, pending, approved, rejected
- **Initial:** draft
- **Transitions:**
  - `draft` → `pending` via action `submit_purchase_request`
  - `pending` → `approved` via action `approve_purchase_request`
  - `pending` → `rejected` via action `reject_purchase_request`
  - `rejected` → `pending` via action `submit_purchase_request`


## Views

| Name | Entity | Type |
|------|--------|------|
| purchase_request_list | purchase_request | list |
| purchase_request_form | purchase_request | form |
| department_list | department | list |


## Capabilities

| Name | Type | Category | Description |
|------|------|----------|-------------|
| cap-adapter-server | adapter | integration |  |
| cap-adapter-mcp | adapter | integration | Exposes LinchKit actions as MCP tools via stdio or SSE transport |
| cap-adapter-ui | adapter | integration |  |
| cap-chatter | standard | system | Unified record timeline: message storage, field-level audit log, and real-time updates. Implements Spec 53 MVP. |
| cap-purchase-demo | standard | business | Demo purchase request capability with approval workflow, showcasing interfaces, derived fields, event handlers, and data masking |


## Dev Commands

```bash
bun run dev:server    # Start server on :3001
bun run dev:ui        # Start UI on :3000 (proxies API to :3001)
bun run test          # Run all tests
bun run check         # Biome lint + format
bun run typecheck     # TypeScript check
bun run db:generate   # Generate migration SQL from schema changes
bun run db:migrate    # Apply pending migrations
```

## Conventions

- **Entity naming:** snake_case
- **Action naming:** verb_noun (e.g. `submit_request`, `approve_order`)
- **Relation naming:** snake_case semantic names for `fromName`/`toName` (e.g. `department`, `purchase_requests`)
- **All mutations** go through Actions — never modify data directly
- **Comments and docs** in English
- **Use `bunx`** never `npx`
- **Commit messages:** Conventional Commits
- **Function signatures:** Use `{}` options object when > 3 parameters
- **System fields** (auto-managed, never set by client): `id`, `tenant_id`, `created_at`, `updated_at`, `created_by`, `updated_by`, `_version`
- **Design patterns:** Apply good design patterns and algorithms, but do not over-engineer
- **File size limit:** Files must not exceed 500 lines — split when approaching the limit
- **API verification:** Verify third-party API usage with context7 before calling — training data may be stale
- **PR merge gate:** All CodeRabbit and Gemini review comments must be replied to and resolved before merging

## Anti-Patterns

- **Do NOT** write to the database directly — all mutations must go through Actions
- **Do NOT** skip CommandLayer — all API endpoints must pass through the 7-slot middleware pipeline
- **Do NOT** use `npm`, `npx`, or `node` — always use `bun` and `bunx`
- **Do NOT** hand-write `CREATE TABLE` / `ALTER TABLE` — always delegate DDL to drizzle-kit