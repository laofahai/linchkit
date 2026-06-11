# Procurement North-Star Scenario — Real-Product Validation of the "Describe → Exists" Loop

> This spec defines **THE scenario every LinchKit capability must serve** — one real procurement-approval product story that composes the horizontal capabilities into a single, live-walkable chain. It plugs into:
> - **Spec 05 / Spec 23 — Rule & Rule Engine** (the threshold policy is a first-class `defineRule()`, enforced via the rule-in-action wiring, PRs #460–#475)
> - **Spec 55 — Evolution System** + **Spec 09 — Proposal & Validation** (the "说→有" loop: NL → governed proposal → approval → graduation PR)
> - **Spec 16 — CommandLayer & API** (every channel funnels through the same 7-slot pipeline; the permission slot is never skipped)
> - **Spec 58 — MCP Client Registry** + **Spec 10 — Actor & Permission** (the AI-agent channel carries its own actor identity, and the rule genuinely discriminates on it)
> - **Spec 52 — AI Deep Integration** / **Spec 71 — AG-UI HITL Governance** (the assistant channel and its approval card)
> - **Spec 69 — AI Evaluation Framework** (P3 AI tracing — every AI call in the loop must be observable)
>
> Without this spec, LinchKit's capabilities — rule engine wired into actions, governance/proposals, code-gen materialization, dry-run sandbox, AI tracing — are each proven **in isolation** but have never been composed into one real product story. Green unit tests are explicitly NOT the acceptance bar here; **live multi-channel walkthroughs are**. The full chain must be REALLY walkable from every channel — browser UI, REST, MCP, and AI agents — with role-gated enforcement and full AI-call tracing.
>
> Tracking milestones: M6 (P1 substrate + rule), M6–M7 (P2 multi-channel walkthrough), M7 (P3 NL loop on this domain).

**Status: Draft.** Phase 1 is in review (branch `feat/purchase-p1-runnable-threshold-rule`); Phases 2–3 have branches in flight (§5). Statuses below are as of 2026-06-11.

---

## 1. Background and Motivation

### 1.1 The composition gap

Every horizontal capability the platform promises has landed and is tested — separately:

| Capability | Proven by | Proven HOW |
|---|---|---|
| Rules fire inside action execution | #460–#475 (`evaluateActionRules`, in-tx re-eval, TOCTOU closed) | unit + e2e tests |
| Governance pipeline (draft→validated→approved→committed) | Spec 09 / Spec 55 §7 | tests + governance UI |
| Code materialization + graduation PR | Spec 55 §7.7 (#494–#496) | live materialize endpoint |
| Execution dry-run sandbox | Spec 70 (#523–#531) | hardened runner, opt-in gate |
| AI tracing | Spec 69 P3 (#553, #557, #562, #564) | `GET /api/ai/traces` live |

What has never existed is **one product story that strings them together** and survives contact with a real browser, a real curl, a real MCP client, and a real AI agent. The 2026-06-10 live-testing wave found 7 wiring-class bugs that green tests could not see (UI blank, flows never firing because UI buttons bypassed actions, `[object Object]` cells) — precisely because nothing forced the capabilities to compose. This spec is that forcing function.

### 1.2 The acceptance philosophy

- **The scenario is the spec.** A capability that cannot serve this scenario end-to-end is not done, whatever its test suite says.
- **Every channel, really.** The same action with the same actor must produce the same allow/block outcome from browser UI, REST, MCP JSON-RPC, and the AI assistant — because all of them go through CommandLayer (Spec 16).
- **Observable, not just correct.** Every AI call made anywhere in the loop must be visible on the AI traces page.

## 2. The North-Star Scenario

An operations user works in a real procurement-approval app (`cap-purchase-demo`). Requests flow draft → pending → approved/rejected; large amounts require a manager.

When policy must change, the user does not write code. They tell the assistant:

> **"以后采购超过1万才走经理审批"** (raise the manager-approval threshold to 10,000)

The system then:

1. **Drafts** a governed rule-change proposal (NL → update of the existing `manager_approval_threshold` rule).
2. A **human approves** it in the governance UI (Spec 09 pipeline; optionally dry-run-validated per Spec 70).
3. The proposal **graduates to a real GitHub PR** (Spec 55 §7.7).
4. **After merge**, approvals genuinely follow the new threshold — enforced identically from every channel — and every AI call along the way is visible on the traces page.

That is the "describe → exists" promise, demonstrated on a product a user would recognize.

## 3. Substrate Facts (verified against the code)

### 3.1 The demo app — `cap-purchase-demo`

- **Entities**: `purchase_request`, `purchase_item`, `department` (`addons/demo/cap-purchase-demo/src/entities/`).
- **State machine** (`src/states/purchase-request.ts`): `draft → pending → approved/rejected`, with resubmit allowed (`rejected → pending` via `submit_purchase_request`).
- **Actions** (`src/actions/`): `submit_purchase_request`, `approve_purchase_request`, `reject_purchase_request`; Phase 1 adds `flag_purchase_for_review` — **internal-only** (`exposure: { http: false, mcp: false, cli: false, ui: false, internal: true }`), a flow-step helper that records audit notes without a state change.
- **Seed data** (`src/seed.ts`): includes `pr_002` — "Cloud Infrastructure Upgrade", **amount 25000, status `pending`** — the canonical over-threshold record every walkthrough uses.

### 3.2 The threshold rule (Phase 1 deliverable — branch `feat/purchase-p1-runnable-threshold-rule`, in review; not on main yet)

`addons/demo/cap-purchase-demo/src/rules/manager-approval-threshold.ts`:

- `MANAGER_APPROVAL_THRESHOLD = 10000`, the **single source of truth** — both the rule and the auto-approval routing flow (`src/flows/purchase-approval.ts`) reference it.
- Trigger `{ action: "approve_purchase_request" }`; a `CodeCondition` checks **stored amount > threshold AND actor is not manager-class** (`purchase_manager` / `manager` / `admin` groups); effect `block` with a bilingual message.
- **Spoof-proof by construction**: the condition reads `record` (the persisted row, threaded untouched by caller input — a Phase-1 core seam on the rule condition context, `packages/core/src/types/rule.ts`), never `target` (which merges caller input over stored values). Sending `{ id, amount: 1 }` cannot bypass the gate.
- Fires via the real core rule-in-action wiring (`evaluateActionRules`) — the approve action stays a pure declarative state transition; the authority lives in the rule.

### 3.3 Channels

| Channel | Fact | Where |
|---|---|---|
| REST | `POST /api/actions/:name` executes with `channel: "http"` | `addons/adapter-server/cap-adapter-server/src/routes/action-api.ts:132` |
| MCP | Separate SSE server on **:3002**; the default MCP actor carries `groups: ["ai_agent"]` — **not** a manager, so the rule genuinely blocks AI agents | `addons/adapter-mcp/cap-adapter-mcp/src/sse-transport.ts` (default port), `mcp-server.ts:131` (default actor) |
| AI assistant | `ActionProposalCard` already surfaces block messages (`status === "error"` renders `errorMessage`) | `addons/adapter-ui/cap-adapter-ui/src/components/action-proposal-card.tsx:417-420` |
| Browser UI | The entity-form action toast **drops** the server's block message (static `t("toast.actionFailed")`) — fix in flight, branch `fix/ui-action-error-surfacing` | `addons/adapter-ui/cap-adapter-ui/src/pages/entity-form-actions.ts:361,371` |
| Tracing | `GET /api/ai/traces` (+ `/:id/generations` drill-down) live on main (#557, #564); the `/admin/ai-traces` page is in flight (branch `feat/ai-traces-admin-ui-350`) | `addons/adapter-server/cap-adapter-server/src/routes/ai-api.ts` |

## 4. Non-Goals

- **NOT a new engine or capability.** Everything here composes existing, shipped machinery; the only new code is the demo-domain rule, small UI/adapter fixes, and the NL-update draft path.
- **NOT a benchmark or load test.** The bar is correctness + observability of one walkable chain, not throughput.
- **NOT full auth rollout.** cap-auth + cap-permission full enablement is out of scope (§7); the rule accepts generic manager groups until then.

## 5. Phases

### Phase 1 — Runnable substrate + threshold-as-rule (branch `feat/purchase-p1-runnable-threshold-rule`, **in review**)

- Fix the undefined-action flow break (the approval flow's `flag_for_review` step previously called an action that only existed as a server-assembled CRUD action — crashed standalone flow runs).
- The `manager_approval_threshold` rule (§3.2).
- The spoof-proof core seam: `record` (persisted row) on the rule condition context.
- The internal-only `flag_purchase_for_review` action.
- Real tests, including spoof regressions (approve `pr_002` with `{ id, amount: 1 }` must still block).

### Phase 2 — Multi-channel live walkthrough (in flight)

- Dev role switching via `x-dev-role` header (branch `feat/dev-role-switching`) so a walkthrough can flip user ↔ manager without full auth.
- UI error surfacing (branch `fix/ui-action-error-surfacing`) so the block message reaches the browser toast.
- **Live evidence**, not test output:
  - Browser: a non-manager is blocked approving `pr_002` (25k) with the rule's message; a manager approves it.
  - REST: the same pair of outcomes via curl.
  - MCP: JSON-RPC `approve_purchase_request` on :3002 — the default `ai_agent` actor is blocked.
  - AI assistant: the `ActionProposalCard` shows the block.
- Every AI call in the walkthrough is traced.

### Phase 3 — The NL loop on this domain (in flight)

- NL draft of an **UPDATE to the existing rule** (branch `feat/nl-rule-update-draft`) — "以后采购超过2万才走经理审批" produces a governed proposal that edits `MANAGER_APPROVAL_THRESHOLD` / the rule, not a new parallel rule.
- Governance approval in the UI (Spec 09), graduation to a GitHub PR (Spec 55 §7.7).
- **Post-merge behavior verification**: a 15k request that blocked before now passes for a regular user; over-new-threshold still blocks — re-verified on every channel.

## 6. Acceptance Criteria

A demo MUST show all of the following, live (not in a test runner):

**Browser UI**
- [ ] Non-manager actor clicks Approve on `pr_002` (25000) → blocked; the rule's bilingual message appears in the toast (not a generic "Action failed").
- [ ] Manager actor approves the same record → state `pending → approved`.
- [ ] A sub-threshold request is approvable by a non-manager.

**REST**
- [ ] `curl -X POST /api/actions/approve_purchase_request` as non-manager → structured block error carrying the rule message.
- [ ] Same call as manager → success; record state changed.

**MCP**
- [ ] JSON-RPC call to `approve_purchase_request` on :3002 with the default client → blocked, because the `ai_agent` actor is not manager-class (the rule, not a transport error).
- [ ] `flag_purchase_for_review` is NOT visible/callable over MCP, HTTP, or UI (internal-only exposure).

**AI assistant**
- [ ] Asking the assistant to approve the 25k request surfaces the block message on the `ActionProposalCard`.

**The NL loop (Phase 3)**
- [ ] The Chinese sentence produces a draft proposal updating the existing rule; a human approves; a real GitHub PR is created; after merge, the new threshold is enforced on every channel above.

**Observability**
- [ ] All AI calls made during the walkthrough are visible in `/admin/ai-traces` (with per-call drill-down).

## 7. Out of Scope / Honest Gaps

- **cap-auth + cap-permission full enablement.** Until then the rule accepts the generic `manager` / `admin` groups alongside `purchase_manager` (§3.2), and Phase 2 uses dev role switching rather than real sessions.
- **Autonomous sensing/feedback loop.** The Spec 55 sensing layer noticing "many over-threshold rejections" and proposing the change *itself* is the next horizon, not this spec's bar — here a human says the sentence.
- **MCP custom-meta role switching.** An MCP client cannot yet present a manager identity (adapter TODO `mcp-server.ts:266`, #217 follow-up) — the MCP walkthrough only demonstrates the *blocked* side.
- **Graduation of code-condition rule updates.** The rule uses a `CodeCondition`; whether the Spec 55 §7.7 graduation path can materialize an update to it (vs. declarative-condition rules) is pending investigation under Phase 3.
