# AG-UI Human-in-the-Loop Governance

> This spec designs the **protocol-native governance of the assistant's write path**: making a model-proposed runtime-data mutation pause the AG-UI run, surface an approval card the human acts on, and resume the run so the approved Action executes through CommandLayer — all carried on the **AG-UI interrupt/resume protocol** (`@ag-ui/core@0.0.56`), not a side channel. It plugs into:
> - **Spec 55 — Evolution System** (the *other* proposal flow — code-change graduation via `ProposalEngine`/`materializeProposalChanges`, Layer-2→Layer-0 Git PRs). **This spec is NOT that.** It governs **runtime data mutations** (create/update/delete a record via an Action), which are distinct in vocabulary, lifetime, and gate count. The naming-collision trap (two unrelated "proposal" / "approve" vocabularies) is called out explicitly in §3.6 and §9.3.
> - **Spec 52 — AI Deep Integration** (intent resolution → `ActionProposalCard` — the user-facing AI write entry the side channel currently uses; this spec subsumes it).
> - **AG-UI adapter work** — #89 (Phase 1: `cap-adapter-ag-ui` run endpoint + protocol re-exports), #546 (AG-UI adapter phase 1 / `@ag-ui/core` `~0.0.56` float), #550 (frontend-tool primitive `buildFrontendToolSet`).
> - **Spec 16 — CommandLayer & API** (the 7-slot pipeline `pre → auth → exposure → permission → tenant → pre-action → post-action`; the approval is a SECOND gate that NEVER skips the permission slot).
> - **Spec 27 — AI Security** (the assistant proposing a mutation is untrusted output; the human + CommandLayer are the trust boundary).
> - **Spec 10 — Actor & Permission** (RBAC; the executed Action is authorized against the *human actor*, not the model).
> - **Spec 04 — Action** (Actions are the sole write entry — this spec keeps that invariant on the assistant path).
>
> Without this spec, the assistant has **two parallel write-governance paths**: the AG-UI stream (read-only by construction) and a `resolveIntent → ActionProposalCard` side channel that bypasses the stream entirely. This spec collapses them into **exactly one** path: model proposes mid-run → run interrupts → existing `ActionProposalCard` renders from the interrupt → human approves → Action executes through CommandLayer → run resumes and finishes.
>
> Tracking milestones: M6 (P1 protocol + P2 runner), M7 (P3 transport/UI + P4 side-channel dismantle), M7+ (P5 hardening + browser e2e).

**Status: Draft.** No code written yet. The AG-UI HITL primitives (interrupt outcome, `resume[]`, client helpers) are **already shipped** in the installed `@ag-ui/core@0.0.56` / `@ag-ui/client@0.0.56` (verified — §3); this spec wires LinchKit onto them.

---

## 1. Background and Motivation

### 1.1 The current gap — bolted-on, not native

The admin assistant has migrated its transport to the AG-UI protocol (#89), but its **write capability did not migrate with it**. Two facts conspire:

**(a) The AG-UI runner is read-only by construction.** `createAssistantAgUiRunner` builds its tools with `allowActionExecution: false` and a system prompt that forbids writes:

> `agui-runner.ts:324-332` — *"Chat is read-only — writes go through the propose-and-confirm flow (intent resolver + ActionProposalCard). See issue #285 / #238."* — `buildSystemPrompt({ ..., allowActionExecution: false })`, and `agui-runner.ts:334-341` — `buildTools({ ..., allowActionExecution: false })`.

That flag gates the one mutating tool. `tools.ts:103` only registers `executeAction` (which calls `commandLayer.execute` at `tools.ts:122-126`) `if (ctx.commandLayer && ctx.allowActionExecution !== false)`. With the flag false, the model on the AG-UI path **literally cannot** call a mutating Action.

**(b) Writes happen on a second path that never touches the stream.** `ai-assistant.tsx:195-238` intercepts every send: when AI is enabled it calls `resolveIntent(trimmed, …)` (`ai-assistant.tsx:203`), and on a `proposal` outcome it renders an `ActionProposalCard` **outside** the AG-UI message stream (`ai-assistant.tsx:219-227`, cards stored in a separate `proposals` state array, rendered at `:335-345`). The card's Execute button calls `executeAction(currentIntent.action, editedInput)` (`action-proposal-card.tsx:293`) → `POST /api/actions/:name` (`api.ts:556-567`). The AG-UI transport is bypassed entirely for the write.

The result is a run that streams over the open standard for *reads*, plus a private REST round-trip for *writes* — the write is invisible to the AG-UI run, the run's message history, any AG-UI middleware, and any conformant AG-UI client. The transport even declares this statelessness: `agui-chat-transport.ts:375` sends `tools: []`, has no `resume`, `reconnectToStream` returns `null` (`:386`), and `createAgUiChunkTranslator` (`:197-262`) has **no interrupt branch** — `RUN_FINISHED` maps unconditionally to a `finish` chunk (`:252-253`).

### 1.2 What exists vs what's new

| Concern | Today | After this spec |
|---|---|---|
| Read path | AG-UI stream (`agui-runner.ts`, read-only tools) | unchanged |
| Write path | side channel: `resolveIntent` → `ActionProposalCard` → `POST /api/actions/:name` (`ai-assistant.tsx:195-238`) | **removed** — folded into the stream |
| Mutation proposal | a standalone REST `resolve-intent` call before/instead of the run | an **interrupt outcome on `RUN_FINISHED`** emitted *by the runner mid-run* |
| Approval surface | `ActionProposalCard` rendered from `IntentResolution` outside the stream | the **same** `ActionProposalCard`, rendered from the interrupt's `responseSchema`/proposed input, inside the stream |
| Approve → execute | UI calls `executeAction` directly (`action-proposal-card.tsx:293`) | UI sends `resume[]`; the **runner** executes through CommandLayer on the resumed run |
| Resume | none — `reconnectToStream → null` (`agui-chat-transport.ts:386`), `tools: []` (`:375`) | a second `RunAgentInput` carrying `resume: ResumeEntry[]` |
| Governance gates | 1 (CommandLayer permission slot — when the side channel reaches it) | 2 (human approval **and** CommandLayer permission slot — neither skippable) |
| Number of write paths | **2** (stream-readonly + side channel) | **1** |

The side channel is not *wrong* — it works, and it predates the AG-UI transport. It is **redundant** once the protocol can carry the same propose→approve→execute shape natively, and a redundant write path is a governance liability (two places to audit, two places a future change can diverge). This spec adopts the native primitive and **dismantles** the side channel (P4) — not a fallback, a removal — per the explicit decision.

---

## 2. Decisions Locked (do not relitigate)

1. **Adopt the AG-UI interrupt/resume protocol natively (Option A).** Not the lighter "execute-less frontend-tool + client-render" path (Option B). The run produces a protocol `interrupt` outcome and accepts a protocol `resume` round-trip. This is what a conformant AG-UI client (CopilotKit and others) expects, and it keeps the write *inside* the run's lifecycle.
2. **Dismantle the side channel; do NOT keep it as a fallback.** After P4 there is exactly one write-governance path (the stream). `resolveIntent`-from-chat in `ai-assistant.tsx` is removed, not demoted.
3. **Scope = runtime DATA mutations** (create/update/delete a record via an Action through CommandLayer). This is **distinct** from the core evolution `ProposalEngine` (code-change graduation). Vocabularies stay separate (§3.6).
4. **Transport stays raw `agent.run()`; the assistant component tracks pending interrupts itself** (the §9.2 fork — resolved to (a), not the stateful-agent rewrite). The current minimal transport (`agui-chat-transport.ts:61-72`) keeps owning history via `useChat`; P3 adds interrupt tracking in `ai-assistant.tsx`. The bigger stateful-agent rewrite ((b) — `pendingInterrupts`/`getCapabilities` for free) is revisited **only if** a conformant external AG-UI client is ever pointed at this endpoint (§9.2 tripwire). We still parse with the client helpers (`getRunOutcome`, `isInterruptExpired`, `buildResumeArray`) — adopting the helpers ≠ adopting the stateful orchestration.
5. **The interrupt carries the N-best alternatives; the card keeps its swap UI** (the §9.4 fork — resolved to (b)). The interrupt's `metadata` carries the server-vetted alternative actions, `ActionProposalCard` keeps `swapAlternative` (`action-proposal-card.tsx:92-133`), and the resume payload may pick a swapped-in action **only from the interrupt's offered set**. This preserves the #238 confidence/alternatives UX *and* §6.2's "action is server-derived" invariant — the human chooses among a server-vetted set, never an arbitrary action.
6. **Keep the intent-resolver server-side as the proposal source; P4 removes the side *channel*, not the *resolver*** (the §9.5 fork). `resolveIntent`'s NL→action+confidence+alternatives extraction (Spec 52) stays as the server-side source that feeds `proposeMutation`'s candidate set. What P4 deletes is the *client-side `resolveIntent`-from-chat interception + the separate `proposals` state path*, not the resolver capability. (If the resolver is invoked server-side from the runner rather than via the old REST route, the old `/api/ai/resolve-intent` route is removed only when no non-assistant caller remains — P4's stated gate.)

> These four+two locks make Spec 71 a **complete plan**, not a design sketch with open forks: every architectural fork §9 raises is resolved here with its rationale. §9 keeps the forks documented as *risks-with-a-chosen-answer* (so the reasoning survives), but they are **not open questions to relitigate** — the answers above are binding for P1–P5.

---

## 3. The AG-UI HITL Protocol (as shipped in 0.0.56)

All symbols below were verified against the **installed** `node_modules/@ag-ui/core/dist/index.d.ts` and `@ag-ui/client/dist/index.d.ts` (both `version: "0.0.56"`). Line numbers are from those files.

### 3.1 Interrupt — carried on `RUN_FINISHED`, not a new event

There is **no `INTERRUPT` or `RESUME` `EventType`.** The `EventType` enum (`core .d.ts:4170-4191`) has only `RUN_STARTED` / `RUN_FINISHED` / `RUN_ERROR` for run lifecycle. The interrupt is delivered as an **optional `outcome` field on the `RunFinishedEvent`** (`RunFinishedEventSchema`, `core .d.ts:9620-9709`):

```
RunFinishedEvent = {
  type: RUN_FINISHED, threadId, runId,
  result?: any,
  outcome?: { type: "success" }
           | { type: "interrupt"; interrupts: Interrupt[] }   // RunFinishedOutcome
           | null
}
```

`outcome` is `z.optional(z.nullable(RunFinishedOutcomeSchema))` (`core .d.ts:9628`, `9709`). `RunFinishedOutcomeSchema` is a discriminated union on `type` of `{type:"success"}` and `RunFinishedInterruptOutcomeSchema` (`core .d.ts:9564-9619`). The interrupt outcome (`RunFinishedInterruptOutcomeSchema`, `core .d.ts:9514-9563`) is exactly `{ type: "interrupt"; interrupts: Interrupt[] }`.

> Implication: a run that needs approval **finishes** (it does not stay open). The server emits `RUN_FINISHED` with `outcome.type === "interrupt"`. The approval + resume is a *new* run on the same `threadId`.

### 3.2 `Interrupt` shape (`InterruptSchema`, `core .d.ts:2267-2291`)

```
Interrupt = {
  id: string;                                  // unique per interrupt
  reason: string;                              // machine code, e.g. "action.approval.required"
  message?: string;                            // human-readable summary
  toolCallId?: string;                         // ties back to the model's tool-call
  responseSchema?: Record<string, any>;        // JSON-schema describing the expected resume payload
  expiresAt?: string;                          // ISO timestamp — approval window
  metadata?: Record<string, any>;              // free-form (we carry the proposed Action+input here)
}
```

### 3.3 `ResumeEntry` shape (`ResumeEntrySchema`, `core .d.ts:2292-2304`)

```
ResumeEntry = {
  interruptId: string;                         // which interrupt this answers
  status: "resolved" | "cancelled";            // approve vs reject
  payload?: any;                               // the human's response (edited inputs for approve-with-edits)
}
```

### 3.4 `resume[]` on the next `RunAgentInput` (`core .d.ts:2984-2996`, `3122-3126`)

`RunAgentInputSchema` carries `resume: z.optional(z.array(ResumeEntrySchema))`. The resumed run sends the **same `threadId`**, a **new `runId`**, and `resume: ResumeEntry[]` answering every open interrupt. The `@ag-ui/client` `RunAgentParameters` exposes exactly this: `resume?: ResumeEntry[]` (`client .d.ts:36-39`, doc-commented *"Per-interrupt responses addressing every open interrupt from the previous run."*).

### 3.5 Client-side support already present (`@ag-ui/client@0.0.56`)

The client package ships HITL plumbing we can lean on rather than reimplement:

- `AgentSubscriber.onRunFinishedEvent` (`client .d.ts:252-260`) is a **discriminated** callback: `{ outcome: "success", result? }` **or** `{ outcome: "interrupt", interrupts: Interrupt[] }`.
- `pendingInterrupts: Interrupt[]` on the agent (`client .d.ts:493-496`) — *"Populated when RUN_FINISHED arrives with outcome.type === 'interrupt'."*
- Helpers in `src/interrupts` (`client .d.ts:618-627`):
  - `getRunOutcome(event: RunFinishedEvent): RunFinishedOutcome | undefined`
  - `isInterruptExpired(interrupt, now?): boolean`
  - `buildResumeArray(interrupts, responses: Record<string, ResumeResponse>): ResumeEntry[]` where `ResumeResponse = { status: "resolved"; payload? } | { status: "cancelled" }`.
- `HumanInTheLoopCapabilitiesSchema` (`core .d.ts:3634-3664`) lets the agent **advertise** `{ supported, approvals, interrupts, approveWithEdits }`. The doc comment on `interrupts` says exactly: *"emits RUN_FINISHED with outcome={ type: 'interrupt', interrupts: [...] }, accepts resume[]"* (`core .d.ts:3643-3646`), and `approveWithEdits`: *"tool-call interrupts accept editedArgs in the resume payload"* (`core .d.ts:3647-3649`).

### 3.6 Naming-collision trap (CRITICAL)

LinchKit already has a **`ProposalEngine`** and an **approve/reject/graduate** vocabulary in core (`packages/core/src/engine/proposal-engine.ts`, lifecycle `draft → validating → validated → approved → committed → deployed`, Spec 55 §7.6/§7.7). That is **code-change graduation** (Layer-2 runtime → Layer-0 Git, double-human-gated, the `materializeProposalChanges` arc, Spec 70's dry-run feeds it).

This spec's "proposal / approve" is a **different thing entirely**: an in-flight, ephemeral **data-mutation** approval that lives for the length of one AG-UI run-pair and never touches Git, never validates source, never graduates. To avoid confusion, this spec uses a **distinct vocabulary** end to end:

| This spec (runtime-data HITL) | Core evolution (code graduation) — DO NOT reuse |
|---|---|
| `Interrupt` (AG-UI primitive) | `ProposalDefinition` |
| `interrupt outcome` | `validateProposal` / Phase 1–5 |
| `resume` (resolved/cancelled) | `approveProposal` / `rejectProposal` |
| `ActionProposalCard` (the data-mutation card — pre-existing name, kept) | `proposal-failed-changes.tsx` / `/admin/proposals` UI |
| reason code `action.approval.required` | `materializationStatus` / `dryRunStatus` |

New code in this spec MUST NOT import from or name-collide with `proposal-engine.ts`. The one unavoidable overlap is the **existing** UI component name `ActionProposalCard` — it predates and is unrelated to `ProposalEngine`, and we keep its name to reuse the component (§4.4).

---

## 4. Target Architecture — one unified write-governance flow

### 4.1 Sequence

```mermaid
sequenceDiagram
  participant U as User
  participant UI as ai-assistant.tsx + AgUiChatTransport
  participant EP as /api/agui/run (run-endpoint.ts)
  participant R as Assistant runner (agui-runner.ts)
  participant M as Model (streamText)
  participant CL as CommandLayer (7-slot)

  U->>UI: "create a product named X, price 9.9"
  UI->>EP: RunAgentInput { threadId, runId=A, messages, resume: undefined }
  EP->>R: runner({ input, emit, signal, request })
  R->>M: streamText(system, messages, tools incl. proposeMutation)
  M-->>R: tool-call proposeMutation{action,input}  (NO execute fn → no DB write)
  R->>EP: (run ends; proposed mutation captured)
  EP-->>UI: RUN_FINISHED { outcome:{type:"interrupt", interrupts:[I]} }
  Note over UI: translator surfaces interrupt I (toolCallId, metadata.action/input, responseSchema, expiresAt)
  UI->>U: render ActionProposalCard(action, input) from I
  U->>UI: edits price → 8.9 → Approve   (or Cancel)
  UI->>EP: RunAgentInput { threadId, runId=B, resume:[{interruptId:I.id, status:"resolved", payload:{action:"create_product", input:{...,price:8.9}, baseDigest:I.metadata.inputDigest}}] }
  EP->>R: runner({ input(resume), emit, signal, request })
  R->>R: validate resume binds to I (toolCallId, action, server-side input re-validation)
  R->>CL: commandLayer.execute({ command:action, input:approvedInput, actor:humanActor, tenant })
  CL-->>R: permission slot → rule slot → handler → result
  R-->>EP: emit TOOL_CALL_RESULT (executed) + assistant text
  EP-->>UI: RUN_FINISHED { outcome:{type:"success"} }
  UI->>U: "Created product X (#...)" + success card state
```

### 4.2 Data carried at each hop

**Interrupt (server → client, on `RUN_FINISHED.outcome.interrupts[]`):**

```
{
  id: <uuid>,                              // the interrupt id; resume must echo it
  reason: "action.approval.required",
  toolCallId: <the proposeMutation tool-call id>,
  message: "Create product \"X\" (price 9.9)?",
  responseSchema: { /* JSON-schema for the resume payload: the action's editable input fields */ },
  expiresAt: <now + approvalWindowMs, ISO>,
  metadata: {
    action: "create_product",
    proposedInput: { name: "X", price: 9.9 },
    inputSchema: { /* IntentFieldSchema-shaped: labels/types/options for the card */ },
    actionLabel: "Create product",
    inputDigest: <hash(action + canonical(proposedInput))>   // anti-TOCTOU anchor (§6.2)
  }
}
```

**ResumeEntry (client → server, on next `RunAgentInput.resume[]`):**

```
// Approve (possibly with edits):
{ interruptId: <id>, status: "resolved",
  payload: { action: "create_product", input: { name:"X", price:8.9 }, baseDigest: <inputDigest from I> } }

// Reject:
{ interruptId: <id>, status: "cancelled" }
```

`payload.action` must be a **member of the interrupt's server-vetted action set** — the primary `metadata.action` *plus* the offered alternatives from §2.5 (carried in the interrupt's `metadata`) — re-validated server-side against that stored set on resume. It is NOT asserted equal-to-primary: §2.5 lets the human swap to a server-offered alternative, so equal-to-primary would make a legitimate swap fail. The anti-TOCTOU guarantee holds regardless — the client can only pick from the server-offered set, never introduce an action outside it (§6.2 point 2). `payload.input` is the **edited** input the human approved (identical to `proposedInput` when they didn't edit). `baseDigest` proves the client resumed *this* interrupt's proposal (§6.2).

### 4.3 Where the proposed mutation is captured (server)

The mutating tool the runner exposes is **execute-less**, mirroring the #550 frontend-tool primitive (`buildFrontendToolSet`, `agui-runner.ts:171-202`): a tool with `type: "dynamic"`, an `inputSchema`, and **no `execute`**. The AI SDK semantics are already documented in `agui-runner.ts:160-162`: *"a step that ends in unexecuted client tool calls produces no tool results, so `streamText` does not start a follow-up step … the stream completes."* So when the model calls `proposeMutation{action,input}`, the run naturally ends with the proposal un-executed — exactly the moment to emit the interrupt outcome.

Concretely: the runner exposes a server-defined `proposeMutation` tool (NOT the read-only `tools.ts` set, NOT a client `input.tools` tool — a first-class server tool with no execute). On run end, if the final step contains a `proposeMutation` tool-call, the runner signals an interrupt to the endpoint instead of a plain finish (the endpoint owns the `RUN_FINISHED` frame — `run-endpoint.ts:200-203` — so the runner returns an interrupt descriptor and the endpoint attaches it to `outcome`).

> **Interface change (note for P2):** the currently exported runner type is `AgUiAgentRunner = (options:{ input; emit; signal?; request? }) => Promise<void>` — it returns `void`, so there is **no channel today** for the runner to hand an interrupt descriptor back to the endpoint. This spec therefore changes that signature to return an **optional interrupt descriptor**: `AgUiAgentRunner = (options:{…}) => Promise<void | AgUiInterruptDescriptor>` (equivalently a typed out-param). `run-endpoint.ts` consumes the returned descriptor and attaches it to `RUN_FINISHED.outcome` (`makeInterruptOutcome`, P1) when present, or emits a plain `outcome:{type:"success"}` finish when the runner returns `void`. This is a real public-type change to `AgUiAgentRunner`, called out here and in the P2 phase row so downstream runner implementations are migrated together.

> Note: `executeAction` (`tools.ts:107-139`, the existing direct CommandLayer tool) stays **off** on the assistant stream (`allowActionExecution:false` is unchanged). It is never the propose tool — proposing and executing are deliberately separated so the human gate sits between them.

### 4.4 Approval UI — reuse `ActionProposalCard` unchanged in shape

`ActionProposalCard` (`action-proposal-card.tsx`) already renders an action label, editable input fields from an `inputSchema`, a confidence-free path, and Execute/Cancel. We feed it from the interrupt:

- `intent.action ← metadata.action`
- `intent.input ← metadata.proposedInput`
- `intent.inputSchema ← metadata.inputSchema`
- `intent.actionLabel ← metadata.actionLabel`

The **one behavioral change**: the card's Execute must NOT call `executeAction` directly (`action-proposal-card.tsx:288-308`). Instead Execute/Cancel raise callbacks the transport turns into a `resume[]` round-trip. This is the central UI rework of P3 — the card stops being a REST trigger and becomes a resume producer. (Approve-with-edits "just works" because the card already tracks `editedInput` at `:269/:273-275`; we send that as the payload.)

### 4.5 Endpoint and transport changes

- **Endpoint** (`run-endpoint.ts`): accept `input.resume`; when present, drive the runner's resume path (execute the approved Action through CommandLayer) instead of a fresh model turn. Attach an `interrupt` outcome to `RUN_FINISHED` when the runner signals one.
- **Transport** (`agui-chat-transport.ts`): (a) carry `resume` into the `RunAgentInput` (`sendMessages` at `:368-383` currently hard-codes none); (b) add an **interrupt branch** to `createAgUiChunkTranslator` (`:197-262`) so `RUN_FINISHED` with an interrupt outcome does NOT just `finish` — it surfaces the interrupt to the UI (via a custom UI part / data chunk the assistant component reads). The client helpers `getRunOutcome` / `pendingInterrupts` (§3.5) do the parsing.
- **Suppress the `proposeMutation` tool-call chunks (REQUIRED).** Because `proposeMutation` is a *server-defined* tool (§4.3), its `TOOL_CALL_START` / `TOOL_CALL_ARGS` / `TOOL_CALL_END` events stream to the client, and `createAgUiChunkTranslator` (`:197-262`) would otherwise translate them into `tool-input-start` / `tool-input-delta` / `tool-input-available` chunks — rendering a raw "Calling proposeMutation…" tool bubble in the chat stream *before* the `ActionProposalCard` even appears. `proposeMutation` is the **interrupt carrier, not a user-visible tool call**: the translator MUST recognize the `proposeMutation` tool-call id (carried as `interrupt.toolCallId`, §4.2) and **suppress or specially-handle** those tool-call chunks — they must not emit a `tool-input-*` chunk to the UI. The proposal surfaces *only* as the `ActionProposalCard` rendered from the interrupt outcome; no raw tool bubble for `proposeMutation` may leak into the message stream.

---

## 5. Run / Interrupt State Machine

States (per `threadId`, across the run-pair):

```
              proposeMutation tool-call on run A
   running ───────────────────────────────────────────▶ interrupted (awaiting-approval)
      │                                                      │
      │ no mutation proposed                                 ├─ human Approve ──▶ resuming(resolved) ──▶ executing(CL) ──┐
      ▼                                                      │                                                          │
   finished(success)                                         ├─ human Reject  ──▶ resuming(cancelled) ─────────────────┐│
                                                             │                                                         ││
                                                             ├─ expiresAt passed ─▶ expired ──▶ finished(declined)     ││
                                                             │                                                         ││
                                                             └─ disconnect/abort ─▶ abandoned (no resume ever sent)    ││
                                                                                                                       ▼▼
                                              CommandLayer result ──▶ finished(success) | finished(error: permission/rule/handler)
                                                                       cancelled ──▶ finished(declined, no mutation)
```

Transitions:

- **running → interrupted**: run A ends with a `proposeMutation` tool-call. `RUN_FINISHED` carries the interrupt outcome. The run **is finished** (AG-UI model); "interrupted" is a UI/logical state awaiting a *new* run.
- **interrupted → resuming(resolved|cancelled)**: a run B arrives with `resume:[{interruptId, status}]`.
- **resolved → executing**: server validates the resume binds to the interrupt (§6.2), then calls `commandLayer.execute`.
- **executing → finished(success|error)**: CommandLayer outcome. A permission/rule/handler failure is a normal `finished` with an error result surfaced in the card (the card already keeps itself mounted on failure — `ai-assistant.tsx:180-184` — so the user can read the error and retry).
- **cancelled → finished(declined)**: no mutation runs.
- **interrupted → expired**: `expiresAt` (`InterruptSchema.expiresAt`) passed before a resume arrived. The client uses `isInterruptExpired` (`client .d.ts:620`) to disable Approve; a late resume for an expired interrupt is **rejected server-side** by the interrupt store (§6.7 — the `expiresAt` is the store entry's authoritative window; never trust the client clock).
- **interrupted → abandoned**: the user closes the panel / disconnects without resuming. No state leaks: because the run already finished, there is no open socket to leak; the proposed mutation was never executed. The store entry is swept on its TTL (§6.7). A later resume for an unknown/forgotten interrupt is rejected (§6.4) because no live store entry matches.
- **Abort during executing**: if the client disconnects mid-execution (`signal.aborted`, already honored at `agui-runner.ts:364` and `run-endpoint.ts:180`), the CommandLayer call is in-flight — Action atomicity (Spec 26) governs whether it commits; the run surfaces `RUN_ERROR`. The mutation is **never** partially applied outside an Action transaction.

---

## 6. Security & Invariants (the governance core)

### 6.1 Approval is a SECOND gate, never a replacement for authz

The executed Action MUST still pass through CommandLayer's **permission slot** (Spec 16's `pre → auth → exposure → permission → tenant → pre-action → post-action`). Human approval gates *intent*; CommandLayer gates *authorization*. Both are required; neither is skippable. The runner executes the approved mutation by the **same** `commandLayer.execute({ command, input, actor })` the existing `executeAction` tool uses (`tools.ts:122-126`) — so the permission/tenant/rule slots run exactly as for any other write. There is no "approved ⇒ bypass authz" shortcut anywhere.

### 6.2 Bind approval to the exact proposed Action+input — no TOCTOU swap

The threat: between propose (run A) and execute (run B) the action name or inputs are swapped, so the human approves one thing and a different thing executes. Defenses, all **server-authoritative** and all enforced against the **interrupt store (§6.7)** — the cross-connection state that makes these guarantees possible:

1. **Resume must reference a live interrupt.** The server keys interrupts by `interrupt.id` (and `toolCallId`) for the `threadId` in the interrupt store (§6.7); a `ResumeEntry.interruptId` that doesn't match an open store entry is rejected (`RUN_ERROR`, no execution).
2. **Action is constrained to the server-vetted set, not client-chosen.** The server stores the interrupt's **action set** — the primary `metadata.action` *plus* the offered alternatives from §2.5 — when the interrupt is emitted. On resume, `payload.action` MUST be a *member* of that stored set, re-validated server-side; an action outside the set is rejected (`RUN_ERROR`, no execution). This is **not** "asserted equal to the primary action": §2.5 (and §9.4) lets the human swap to a server-offered alternative, so an equal-to-primary check would reject a legitimate swap. The anti-TOCTOU guarantee is fully preserved — the client still cannot introduce an action the server did not vet and offer; it can only choose among the set the server already authored into the interrupt. The chosen action is then executed exactly as in §6.1 (CommandLayer permission/tenant/rule slots run unconditionally).
3. **Input digest anchors the proposal.** `metadata.inputDigest = hash(action + canonical(proposedInput))` is set when the interrupt is emitted. On resume, the server recomputes the expected base and validates the approved input against the action's **own input schema** (the same validation any `/api/actions/:name` write gets). Approve-with-edits is *legitimate* divergence — the human deliberately changed `price` — so we do NOT require `editedInput === proposedInput`; we require (a) same action, (b) `baseDigest` echoes the interrupt's `inputDigest` (proves this resume answers this proposal, not a replay of a different one), and (c) the edited input independently passes the action's schema + CommandLayer slots. The human's edits are authorized just like any human-entered Action input.
4. **One-shot resume.** The store entry's `consumed` flag is flipped via compare-and-swap on first resume (§6.7); a replayed `resume` for an already-consumed interrupt fails the CAS and is rejected (`RUN_ERROR`, no double-execute) — and the CAS also serializes two concurrent resumes so only one can execute.

### 6.3 Tenant / actor scoping

The Action executes as the **human actor** resolved from the request (`agui-runner.ts:302-306` via `options.resolveRequestActor`), tenant-scoped via `options.resolveRequestTenantId` (`:309-312`) — **never** as the model or a synthetic `ai-assistant` system actor. (The existing `executeAction` tool falls back to `{ type:"system", id:"ai-assistant" }` at `tools.ts:105`; the HITL path MUST use the real human actor so RBAC and tenant isolation bind to the person who clicked Approve.) The resume round-trip carries the same auth headers as run A; the server re-resolves actor+tenant on run B (does not trust a client-asserted actor).

**Fail closed on the write/resume path (REQUIRED).** The existing read-only runner resolves the actor as `(await resolveRequestActor(request)) ?? ANONYMOUS_ACTOR` (`agui-runner.ts:303-306`). That anonymous fallback is acceptable on the **read-only chat path** (a stream that cannot write), but it MUST NOT apply on the resume/execute path: if `resolveRequestActor` is unconfigured or returns `undefined` on run B, falling back to `ANONYMOUS_ACTOR` would let an **unauthenticated write execute as anonymous**, defeating this section's "executes as the human actor, not the model/synthetic" guarantee. Therefore the resume handler MUST **reject the resume** when no real, authenticated human actor resolves — `RUN_ERROR`, **no `commandLayer.execute`** — and MUST NEVER substitute `ANONYMOUS_ACTOR`, `{ type:"system", id:"ai-assistant" }`, or any other system/synthetic actor on the write path. (The read-only chat path keeps its anonymous fallback; only the WRITE/resume path fails closed.)

### 6.4 Permission the user lacks — reject at execute time, surface honestly

If the model proposes an Action the human lacks permission for, two timings:

- **Propose-time pre-check (UX, advisory):** the runner MAY check exposure/permission for the proposed action against the actor before emitting the interrupt, and set `metadata.permitted: false` so the card can show "you don't have permission to do this" instead of a dead Approve button. This is a *hint*, not the gate.
- **Execute-time enforcement (authoritative):** even if the pre-check is skipped or stale, the CommandLayer permission slot on run B denies the execution and the run finishes with a permission error. **The gate is always execute-time CommandLayer** — the pre-check only improves UX. We never rely on the model or the card to enforce permission.

Separately, a resume that names an **unknown or forgotten interrupt** (no matching live entry in the interrupt store — absent, expired, or already-consumed) is rejected before any execute: `RUN_ERROR`, no `commandLayer.execute`. This is enforced by the interrupt store lookup (§6.7), not by trusting the client to only resume real interrupts.

### 6.5 The model never writes directly

`proposeMutation` has no `execute` (§4.3): the model can only *propose*. The only code that calls `commandLayer.execute` on the assistant path is the runner's **resume** handler, reached only after a human `status:"resolved"`. This preserves CLAUDE.md's "Action as Sole Write Entry" + "AI Never Modifies Production Directly" on the assistant surface, end to end.

### 6.6 Audit

Every interrupt + resume is logged (proposed action+input, who approved, edited-vs-proposed delta, the resulting `executionId`). The executed Action already lands in the Execution Log (Spec 11) via CommandLayer; this spec adds the **approval provenance** (which human, which interrupt, edited inputs) so a reviewer can answer "the AI proposed X, a human approved X′, and X′ executed as execution #N."

To make that provenance **reliably persisted and queryable alongside the executed mutation** (not in a separate side log that could drift from the Execution Log), the resume handler attaches it to **Spec 65's `ExecutionMeta` (Execution Context)** on the `commandLayer.execute` call. The HITL approval metadata — `{ proposedAction, proposedInput, approvedAction, approvedInput, editedVsProposedDelta, interruptId, approvedBy (the human actor), approvedAt }` — rides on `ExecutionMeta` so it lands **in the same Execution Log row** as the mutation it authorized. A reviewer querying the Execution Log for execution #N therefore sees both the executed write *and* the AI-proposed → human-approved chain that produced it, atomically joined, with no separate join key to maintain. (Reference: Spec 65 `ExecutionMeta` / Execution Context — the canonical carrier for per-execution out-of-band metadata.)

### 6.7 Interrupt store — the load-bearing state

Everything in §6.2 (one-shot resume, anti-TOCTOU action-set binding, digest anchoring), §6.4 (unknown/forgotten interrupt → `RUN_ERROR`), and the §5 expiry/abandon transitions assumes the server can, on run B, **look up the interrupt it emitted on run A** — yet run A's SSE stream and run B's resume request are **two separate, stateless HTTP connections** (§9.2 keeps the transport stateless; the run already *finished* per §3.1). The state that bridges them is never named elsewhere in this spec. It is the load-bearing piece, specified here.

**The store.** A server-side **interrupt store** keyed by `(threadId, interrupt.id)` (with `toolCallId` as a secondary lookup). Each entry holds exactly what the resume path must re-derive server-authoritatively rather than trust from the client:

```
InterruptStoreEntry {
  threadId, interruptId, toolCallId,
  actionSet:    string[],                 // primary action + offered alternatives (§2.5, §6.2 point 2)
  proposedInput: Record<string, any>,     // the model's proposed input (§4.2 metadata.proposedInput)
  inputDigest:   string,                  // hash(action + canonical(proposedInput)) — baseDigest anchor (§6.2 point 3)
  expiresAt:     string,                  // ISO; server-authoritative approval window (§5, §6.7 lifecycle)
  consumed:      boolean,                 // one-shot flag (§6.2 point 4)
  actor:         ActorBinding,            // the run-A human actor identity for re-verification (§6.3)
  tenantId:      string                   // the run-A tenant scope (§6.3)
}
```

**Lifecycle.**
- **Written** when the interrupt outcome is emitted on run A (`RUN_FINISHED.outcome.type === "interrupt"`) — the entry is the server's record that this proposal is open.
- **Read + CAS-consumed** on run B's resume: the handler loads `(threadId, payload.interruptId)`, atomically checks-and-sets `consumed = true` (compare-and-swap so two concurrent resumes can't both execute — closes the §6.2 point-4 one-shot race), then validates `payload.action ∈ actionSet`, `payload.baseDigest === inputDigest`, `now < expiresAt`, and the re-resolved run-B actor/tenant against the stored binding (§6.3).
- **Evicted** on consume (success or rejection after CAS), on expiry (`now ≥ expiresAt`), or on abandon (TTL sweep — the user disconnected without resuming, §5 *abandoned*).

**A resume referencing an absent, expired, or already-consumed entry is rejected server-side** — `RUN_ERROR`, **no `commandLayer.execute`** — never executed on faith. This is the single enforcement point behind §6.2 point 1, §6.2 point 4, §6.4's "forgotten interrupt," and §5's `expired`/`abandoned` transitions.

**Persistence choice (operational, load-bearing).** An **in-process `Map`** is acceptable *only* for a single-instance dev/demo deployment. For any **multi-instance / production** deployment it MUST be a **shared, durable store** — the established **addon-owned `_linchkit.*` Postgres table** pattern (a `pgTable` def in the addon + `db:push`, the same provisioning peers like `watcher_state`/`mcp_clients` use) — because run A and run B can land on different instances; a per-instance in-memory map would make one-shot consumption and expiry **break silently across instances** (run B on instance 2 wouldn't see instance 1's `consumed` flag → double-execute; or wouldn't find the interrupt at all → spurious `RUN_ERROR`). The store interface is therefore defined behind a small abstraction so the dev `Map` and the prod Postgres table are swappable without touching the resume logic.

Cross-referenced by **§5** (the `interrupted`/`expired`/`abandoned` transitions resolve against this store), **§6.2** (points 1–4 enforce against this store), and **§6.4** (the unknown/forgotten-interrupt rejection reads this store).

---

## 7. Implementation Phases (each an independently shippable PR)

| Phase | Deliverable | Affected files | Smoke / e2e |
|---|---|---|---|
| **P1 — protocol** | Extend the `cap-adapter-ag-ui` protocol allow-list to re-export the interrupt/resume types (`Interrupt`, `ResumeEntry`, `RunFinishedOutcome`, `RunFinishedInterruptOutcome`) + a typed **interrupt-outcome helper** (`makeInterruptOutcome(interrupts)`) and a `RUN_FINISHED`-with-outcome encoder, so the rest of the addon imports them from one place. | `protocol.ts:19-60` (add the type re-exports — currently exports **none** of the interrupt/resume symbols), `index.ts` barrel (mirror the new exports), `run-endpoint.ts` (extend `AgUiEmit`/the `RUN_FINISHED` frame to carry an `outcome`) | unit: encoder round-trips an interrupt outcome through `RunFinishedEventSchema.safeParse`; `ResumeEntrySchema` parses our payload shape |
| **P2 — server runner** | The runner exposes the execute-less `proposeMutation` server tool, captures a proposed mutation, and signals an interrupt outcome on run end; the endpoint accepts `input.resume` and, on `status:"resolved"`, executes the approved Action through `commandLayer.execute` with the human actor + §6 bindings; on `cancelled`, finishes with no write. **Signature change (§4.3):** `AgUiAgentRunner`'s exported type changes from `=> Promise<void>` to `=> Promise<void \| AgUiInterruptDescriptor>` (return an optional interrupt descriptor); `run-endpoint.ts` consumes the returned descriptor to attach the `RUN_FINISHED.outcome`. Migrate all downstream runner implementations together. | `agui-runner.ts:283-369` (add propose tool + interrupt signal + resume-execute path; **change the `AgUiAgentRunner` return type** to the optional interrupt descriptor; keep `allowActionExecution:false` for the existing read tools), `run-endpoint.ts:155-264` (consume the returned descriptor, resume branch, attach `outcome`), `tools.ts` (a dedicated `proposeMutation` builder, distinct from `executeAction`) | server test (`app.handle`): run A with a "create X" message yields `RUN_FINISHED` + interrupt outcome; run B with `resume:resolved` executes via CommandLayer (assert the record exists, permission slot ran); `resume:cancelled` writes nothing; a swapped (outside the offered set)/expired interrupt is rejected |
| **P3 — UI transport + card** | Transport carries `resume[]` into `RunAgentInput`, adds an **interrupt branch** to `createAgUiChunkTranslator`, and **suppresses the `proposeMutation` tool-call chunks** (§4.5 — they must NOT translate to `tool-input-*` chunks, so no raw "Calling proposeMutation…" bubble leaks before the card); `ai-assistant.tsx` renders `ActionProposalCard` from the interrupt; Approve/Cancel emit `resume[]` (using `buildResumeArray`) instead of calling `executeAction`. | `agui-chat-transport.ts:368-383` (thread `resume`), `:197-262` (interrupt branch via `getRunOutcome` **+ suppress `proposeMutation` tool-call chunks** keyed on `interrupt.toolCallId`), `:386` (resume replaces the `reconnectToStream→null` stub or a parallel resume entry point), `ai-assistant.tsx` (render card from interrupt, wire Approve→resume), `action-proposal-card.tsx:288-308` (Execute raises a callback, no direct `executeAction`) | browser e2e (§8): real prompt → card renders from the interrupt → edit + Approve → record changes; Cancel → no change; **assert no raw `proposeMutation` tool bubble appears in the stream** |
| **P4 — DISMANTLE the side channel** | **The mandated removal.** Delete the `resolveIntent`-from-chat interception in `ai-assistant.tsx` (`:195-238`) and its routing helper usage; remove the parallel `proposals` state path that bypassed the stream (`:126`, `:219-227`, `:335-345`); the stream is now the **only** write path. Remove or repurpose `resolveIntent` client fn (`api.ts:750`) and the `/api/ai/resolve-intent` route **only if** nothing else uses them (verify — they may serve non-assistant callers; if so, leave the route, remove only the chat interception). | `ai-assistant.tsx` (remove side-channel branch + `proposals` state), possibly `api.ts:652-774` + the `ai-resolve-intent.ts` route (gated on no other consumers), `decideIntentRouting`/`IntentRoutingDecision` (remove if now dead) | regression: every mutation the old side channel served now flows through the stream; no `POST /api/ai/resolve-intent` from the assistant panel; e2e parity with P3 |
| **P5 — hardening + e2e** | Approve-with-edits server validation hardening (§6.2), expiry enforcement server-side, one-shot resume, audit provenance (§6.6), advertise `HumanInTheLoopCapabilities { interrupts:true, approveWithEdits:true }` from the runner, and the full browser e2e in CI. | `run-endpoint.ts`/`agui-runner.ts` (validation + audit), capability config (advertise capabilities), e2e harness | the §8 e2e runs green in CI against merged main (puppeteer-core + system Chrome per the project's established browser-e2e approach) |

P4 is explicitly the **"dismantle the side channel"** step. P1–P3 build the native path *alongside* the side channel (both work during the transition); P4 removes the old path so exactly one remains. Shipping P4 only after P3 is verified e2e avoids a window with zero working write path.

Each phase follows the standard lifecycle (worktree → quality gates → cross-model review → PR) and keeps `core` untouched (this lives entirely in the two adapter addons + UI).

---

## 8. Browser e2e (mandatory — the user's standing demand)

Green unit tests cannot prove this works (the project has repeatedly found wiring-class bugs only a real browser catches). The acceptance e2e, against a real boot + merged main:

1. Boot server (:3001) + UI (:3000) with a live AI provider and a seeded entity (e.g. `product`) the human actor can create.
2. Open the assistant panel, type *"create a product named Widget priced 9.9"*.
3. **Assert**: an `ActionProposalCard` appears **inside the assistant message stream** (not as a detached side-channel card), pre-filled `name=Widget price=9.9`, sourced from a `RUN_FINISHED` interrupt outcome (assert the network: run A returns an interrupt outcome, not a plain finish).
4. Edit price → 8.9, click Approve.
5. **Assert**: a second run (same `threadId`, `resume:[{status:"resolved"}]`) is sent; the record **actually exists** in the DB with `price=8.9` (query it); the card shows success; the run finishes `outcome:success`.
6. **Negative**: a Cancel path leaves no record; an action the actor lacks permission for shows the permission error from CommandLayer (not a client-side block), and no record is written.
7. **Anti-TOCTOU**: a forged resume with a swapped action name is rejected by the server (assert `RUN_ERROR`, no write).

Browser strategy follows the project's established choice: **puppeteer-core + system Chrome** (Playwright hangs under Bun — #545), driving the real UI.

---

## 9. Risks & Open Questions (honest)

1. **0.0.x protocol churn.** `@ag-ui/core`/`client` are pinned `~0.0.56` (float, #546). The interrupt/resume surface is young; a 0.0.x bump could rename/reshape `RunFinishedOutcome` or `ResumeEntry`. Mitigation: all protocol types funnel through `protocol.ts` (one allow-list to update), and the addon validates with the upstream schemas (`.safeParse`) so a shape drift fails loudly, not silently.
2. **Transport statelessness vs a resume round-trip.** **[RESOLVED → Locked Decision §2.4: keep raw `run()`, track interrupts in the assistant component.]** The transport is deliberately stateless today (`reconnectToStream → null`, `agui-chat-transport.ts:386`; `useChat` owns history). The resume round-trip needs the client to remember the open interrupt(s) between run A and run B. The AG-UI client's `pendingInterrupts` (§3.5) is designed for exactly this, but our transport bypasses the stateful `runAgent()` orchestration in favor of raw `agent.run()` (`agui-chat-transport.ts:61-72`). **Open question:** do we (a) keep raw `run()` and track pending interrupts ourselves in the assistant component, or (b) adopt the stateful agent so `pendingInterrupts` + `getCapabilities` come for free? (a) keeps the current minimal transport; (b) is more idiomatic AG-UI but a bigger transport rewrite. Recommend (a) for P3, revisit (b) if a conformant external client is ever pointed at this endpoint.
3. **Naming collision with core `ProposalEngine`** (§3.6). The risk is human + future-AI confusion, not a runtime bug. Mitigation: the distinct-vocabulary table (§3.6) and a code-review rule that new HITL code never imports `proposal-engine.ts`.
4. **Backward-compat / UX change from removing the side channel.** **[RESOLVED → Locked Decision §2.5: carry N-best alternatives in the interrupt metadata, keep the card's swap UI, validate the chosen action against the server-vetted set.]** Today low-confidence proposals surface a card with "Did you mean" alternatives + confidence badges (`ActionProposalCard` + `decideIntentRouting`, the #238 fix). The interrupt path carries a single proposed Action — **does the native interrupt model support the N-best alternatives + confidence UX, or do we lose it?** Options: (a) the runner proposes the single best action (simplest; loses alternatives); (b) the interrupt's `metadata` carries alternatives and the card keeps its swap UI (`swapAlternative`, `action-proposal-card.tsx:92-133`), with the resume payload free to pick a swapped-in action — but then §6.2's "action is server-derived" must allow the human to choose among a **server-vetted set** of alternatives carried in the interrupt, not an arbitrary action. Recommend (b): carry the alternatives in `metadata`, and on resume validate the chosen action is one of the interrupt's offered set. This preserves the #238 UX *and* the anti-TOCTOU invariant.
5. **Confidence/intent-resolution reuse.** **[RESOLVED → Locked Decision §2.6: keep the intent-resolver server-side as the proposal source; P4 removes the side channel, not the resolver.]** The side channel's value-add was `resolveIntent`'s NL→action+confidence extraction (Spec 52). The native path lets the *model itself* propose via `proposeMutation`. **Open question:** do we keep the dedicated intent-resolver (better-calibrated confidence, alternatives) feeding `proposeMutation`'s candidate set server-side, or trust the agent's own tool-call? Recommend keeping the intent-resolver server-side as the source of the proposed action + alternatives (reuse, not rewrite), with `proposeMutation` as the protocol carrier — so P4 removes the *side channel*, not the *resolver*.
6. **Two runs per mutation.** The protocol models approval as run A (propose) + run B (resume) — two SSE connections, not one long-lived one. This is by design (§3.1) but means the UI must clearly tie run B back to run A's card; if `threadId` continuity or interrupt-id tracking is buggy, an approval could attach to the wrong card. Covered by §6.2 + the e2e (§8 step 5).
7. **Expiry semantics.** `expiresAt` is advisory on the client (`isInterruptExpired`) but **authoritative on the server** (§6 / state machine). Picking the window (`approvalWindowMs`) is a config decision — too short frustrates users mid-edit; too long widens the TOCTOU window. Default proposal: 10 minutes, configurable.

---

## 10. Relationship to Existing Specs

- **Spec 55 (Evolution)** — the *other* proposal flow. This spec adds a forward-distinction note (and §3.6): runtime-data HITL ≠ code-graduation. No `ProposalEngine` coupling.
- **Spec 52 (AI Deep Integration)** — the intent-resolver + `ActionProposalCard` it defined are **reused as the proposal source**, but the *delivery* moves from a side channel to the AG-UI stream. Spec 52's "propose → confirm → execute" stays; only the transport changes.
- **Spec 16 (CommandLayer)** — unchanged and load-bearing: the approved Action runs through all 7 slots; the permission slot is never skipped (§6.1).
- **Spec 27 (AI Security)** — the model's proposal is untrusted output; the human + CommandLayer are the trust boundary; §6.2 closes the propose→execute TOCTOU.
- **Spec 10 (Actor & Permission)** — the Action authorizes against the human actor who approved, not the model (§6.3).
- **Spec 04 (Action)** — Actions remain the sole write entry on the assistant path; `proposeMutation` proposes, only the resume handler executes (§6.5).
- **#89 / #546 / #550** — this is the natural continuation: #89 brought the transport, #550 brought the execute-less frontend-tool primitive this spec reuses to capture the proposal, and this spec brings the write path onto the protocol.
