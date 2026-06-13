# @linchkit/cap-adapter-server

## 2.0.0

### Minor Changes

- 738d9e9: Bridge the Spec-55 evolution cycle into the governance review pipeline (on-demand). The evolution `runCycle()` was never invoked at runtime and its proposals were transient — they never reached human review. New `persistCycleProposalsAsDrafts` helper (`@linchkit/core`) maps each cycle `ProposalDefinition` to a governance `draft` via `ProposalEngine.createProposal`, deduped against the already-pending set (capability + change names) so re-running a cycle is idempotent. New `POST /api/evolution/run-cycle` endpoint (`@linchkit/cap-adapter-server`) runs one cycle on demand through CommandLayer (permission slot never skipped; 501 when the evolution runtime is absent, 503 when the command layer is absent) and persists the results as drafts, returning `{ created, deduped, total, createdIds }`.

  Strictly drafts-only: nothing is submitted, validated, approved, committed, deployed, or graduated, and there is no scheduler — invocation cadence and graduation (to files/PR) remain deferred. Pre-analysis envelopes are not attached (no slot on the proposal shape; out of scope).

- 228a3fc: feat(adapter-server): GraphQL `batch_actions` mutation (closes #212)

  Adds a code-first `Mutation.batch_actions(actions: [BatchActionInputItem!]!, strategy: String, meta: String): BatchActionsResult!` that mirrors the REST `/api/actions/batch` contract. Per-item input is JSON-string-encoded for parity with the existing `executeAction` mutation (graphql-js code-first ships no JSON scalar), and `BatchActionsResult` exposes `success` / `parentExecutionId` / `strategy` / `succeeded` / `failed` / `rolledBack` / `summary`. Resolved through the same actor / tenant / locale path single-action mutations use; raw-executor fallback intentionally rejected so the permission slot is never bypassed. Optional `transactionManager` on `BuildGraphQLSchemaOptions` lets callers override the CommandLayer default for `executeBatch`.

- 1780b57: Wire an in-process `SyncFlowEngine` into the `createDevApp` / `createRuntimeContext` boot path so a `trigger_flow` rule effect actually starts its flow. Previously this DB-free, in-process path never aggregated capability flows nor built a flow engine, so the effect silently logged + skipped. `createRuntimeContext` now accepts `flows` and builds a default sync engine from them; `assembleDevSchema` / `extractCapabilities` aggregate `cap.flows`. An externally injected `flowEngine` (e.g. the durable Restate engine wired by `linch dev`) still takes precedence and is unaffected.

  Also forward the Saga compensation idempotency key (Spec 26 §3.2) from the flow step context into `executor.execute` in both flow-engine wiring sites (`createRuntimeContext` and `dev-wiring.ts`), so a retried compensating action started through the sync flow engine is not executed twice. (#476)

- 13696ca: feat(adapter-mcp): `resolve_schema_intent` MCP tool — NL→governed proposal (#583)

  MCP agents can now send a natural-language utterance and get a governed proposal draft, the same capability the HTTP route provides — closing the "every channel" gap for 说 → 有. Adds `proposalEngine` to `TransportContext` and forwards it through the MCP factory, which also activates `create_proposal` (previously dormant in the dev MCP path because the engine never reached the adapter).

- 13696ca: feat(说 → 有): NL schema-intent drafts a governed `add_entity` proposal (#575)

  The schema-intent resolver now turns an utterance like "增加一个商品管理" into a governed `add_entity` ProposalDraft (instead of `no_match`). A new `schema-intent-entity-builder` validates the entity shape (snake_case name, no system-field collisions, valid field types/constraints, optional relation endpoints) and mints the draft; `POST /api/ai/resolve-schema-intent` persists it into the shared governed engine so it surfaces in the human-gated review pipeline. Works on an empty catalog (first entity), and surfaces requested-but-malformed relations as errors rather than silently dropping them.

- d4f4a2f: Add a manual, admin-triggered graduation path for approved proposals (Spec 55 §7.6/§7.7). New `POST /api/proposals/:id/graduate` writes an already-`approved` proposal's definition files to disk (`ProposalFileWriter`) and opens a GitHub PR (`ProposalGitCommitter.commitAndOpenPR`). It **never auto-fires on approval** (no `onApproved` wiring, no scheduler) and **never auto-merges** — graduation is human-triggered and the resulting PR is human-reviewed, preserving "AI never modifies production directly".

  Guards: `404` if the proposal is missing; `422` if it is not `approved` (the guard runs before any side effect); `503` `GRADUATION.NOT_CONFIGURED` (resolved before touching the engine, no existence leak) when git/GitHub is not configured. Config is sourced from the environment (`GITHUB_TOKEN`/`GH_TOKEN` required; optional `PROPOSAL_GRADUATE_ROOT_DIR`/`_BASE_BRANCH`/`_REMOTE`). On success it records the graduation (approved→committed) best-effort and returns `{ prUrl, branch, commitSha, committed }`.

- 13696ca: feat: graduate an NL-drafted relation as a first-class change (#580)

  `relation` is now a first-class graduable `ProposalChange`: added to `ProposalChangeTarget` and the `ChangeDefinition` union, wired into `ProposalFileWriter` (relations/ subdir, `defineRelation` factory), and classified additive/non-breaking by the impact analyzer. An `add_entity`-with-relation proposal now persists a SECOND `relation` change (the entity change stays a clean `EntityDefinition`) and graduates to BOTH `defineEntity()` and `defineRelation()` source.

- 106e926: Make the autonomous evolution cadence loop observable (Spec 55 §7). An operator
  could start the cadence scheduler but had no way to see whether it was actually
  alive — ticking, idle, or stuck on a repeating error.

  `EvolutionScheduler` gains a read-only `getStatus(): EvolutionSchedulerStatus`
  liveness snapshot (running, clamped intervalMs, ticksStarted/ticksCompleted,
  last-tick timestamps + duration, lastError, consecutiveErrors). The counters are
  tracked inside the non-overlapping tick runner; the snapshot clones its `Date`s
  so callers cannot mutate scheduler state. A successful tick clears the error
  streak; a thrown tick still "completes" and increments `consecutiveErrors`.

  The adapter-server exposes it at `GET /api/evolution/scheduler-status`, dispatched
  through the **same CommandLayer permission path** as `/api/evolution/run-cycle`
  (synthetic `evolution.scheduler_status` command, `skipActionSlots`): 503 when no
  CommandLayer is configured, 401/403 canonical `AUTHZ_DENIED` on denial, `200
{ configured: false }` when cadence is disabled, and `200 { configured: true,
...status }` (Date fields as ISO strings) when a scheduler is wired. Permission
  runs before anything is reported, so an unauthorized caller cannot even learn
  whether cadence is configured.

  A real-`createServer` smoke test drives the endpoint through the canonical server
  factory (the same assembly `http-transport` boots), advances the scheduler with
  `runOnce()`, reads the live state back over HTTP, and asserts the read fails
  closed (`PERMISSION.MIDDLEWARE_MISSING`) when no permission middleware is present.

- e4d210e: Activate dormant server-engine wiring so SSE subscriptions, approvals, and cache stats work.

  The `createServer(...)` calls in both boot paths omitted engines that the rest of the stack expects:

  - `http-transport.ts` (the real `linch dev` path) never passed `eventBus`, `approvalEngine`, or `cacheManager` from the transport context, so `/api/subscribe` (SSE), `/api/approvals`, and `/internal/cache/stats` were silently disabled (`subscription-api` bailed on a missing bus, `approval-api` returned 501).
  - The in-process path (`assembleDevSchema` → `createRuntimeContext` → `createDevApp`) never built or wired an event bus at all, so domain events never reached SSE subscribers.

  `assembleDevSchema` now builds an in-memory event bus and threads it through `createRuntimeContext` (which forwards it to the action executor so actions emit domain events) and into `createServer`. A new DB-free SSE e2e (`app.handle`) guards the path. Also adds a duplicate-name guard to action registration in `createRuntimeContext`, mirroring the existing `build-registries` / `http-transport` guard.

- 9626920: Implement proposal-validation Phase 3 (compatibility / breaking-reference checks, Spec 09 §4.5). `validatePhase3` inspects a proposal's delete/narrowing changes against the current meta-model (via the OntologyRegistry impact graph + field-reference scan) and flags breaking references: deleting a field still referenced by a view/rule, deleting an action/state with dependents, changing a field type, dropping a required field's default, or removing an enum value.

  Warn-only by default (does not affect `passed`); escalates to blocking errors when `strictCompatibility` is set. A new `features.strictCompatibility` env flag (default: true in production and staging, false in dev/test, mirroring `strictValidation`) wires this through `mountProposalAPI` so production and staging refuse proposals that break existing references while dev/test stays advisory. `ValidationContext` gains optional `ontology` + `strictCompatibility` fields; when absent, Phase 3 degrades to "skipped" so existing callers are unchanged.

- 685ccc1: feat(core): wire require_approval + record-state into rule evaluation (Spec 23 §1.1, phase 2)

  Builds on the phase-1 wiring (block/warn/enrich). The action executor now handles the `require_approval` rule effect and evaluates rule conditions against the pre-existing record.

  **require_approval.** `createActionExecutor` gains an optional `approvalEngine` (`ActionApprovalSuspender`) plus a late-binding `executor.setApprovalEngine()` seam (the executor and the approval engine are mutually dependent — the engine re-executes actions via the executor). When a `require_approval` rule fires, the executor suspends the action: it calls `approvalEngine.createRequest({ action, input, actor, effect, triggerRules, ... })` and returns the `ApprovalPendingResult` instead of writing. `ApprovalEngine.approve()` later re-executes with `skipRules = triggerRules` so the approval rule does not re-fire. When no approval engine is wired, a `require_approval` effect lets the action proceed (best-effort gate, not a silent hard block).

  **Record-state conditions.** Rule evaluation moved after provider setup so that, for updates (input carries an `id`), the executor reads the current record via the tenant-scoped provider and evaluates conditions against `{ ...record, ...input }`. Rules can now reference existing field values (e.g. "block edits when status is closed"), with input overriding record state. A read failure degrades to input-only.

  **Wiring (all production paths).** CLI `dev` calls `executor.setApprovalEngine(approvalEngine)`. The adapter-server `createRuntimeContext` now constructs an approval engine (in-memory store; persistence via `DrizzleApprovalStore` is a boot-path follow-up), wires it both ways (executor ↔ engine, re-execution via the CommandLayer), and exposes it on `RuntimeContext`; `dev` / `dev-app` pass it to `createServer` so the approval API routes work. Previously the server had **no** approval engine, so server-side `require_approval` never functioned.

  Tests: `action-engine-rule-integration.test.ts` adds require_approval (suspend → pending, no write; no-engine → proceeds; `setApprovalEngine` seam; skipRules bypass) and record-state (record-derived condition fires; input overrides record) cases — all through the real executor. Non-breaking: omitting `rules` / `approvalEngine` preserves prior behavior. No `any`/`!`.

- 76511f7: feat(core): wire business-rule evaluation into the action execution path (Spec 23 §1.1, phase 1)

  `defineRule()` business rules are now evaluated during action execution. Previously the rule engine (`evaluateRules`) was a tested-but-unwired pure function: rule effects (block / warn / enrich / require_approval / execute_action) were collected by the engine but never applied when an action ran through the executor, so rules did not fire end-to-end.

  `createActionExecutor` gains an optional `rules?: RuleDefinition[]`. When provided, the executor runs `collectRules(actionName, rules)` + `evaluateRules` after input validation and before the write, and applies the pre-write decision effects:

  - **block** → aborts the action with the block reason(s); the handler and write never run.
  - **enrich** → merges `setFields` into the input that reaches the handler / write path.
  - **warn** → surfaces messages on `ActionResult.warnings`; the action still succeeds.

  Only rules whose `trigger.action` targets the running action fire; `skipRules` (approved re-execution) is honored. Conditions are evaluated against the validated input — record-state conditions (reading the pre-existing record) and the post-commit effects (`require_approval`, `execute_action`, `trigger_flow`) land in follow-up phases.

  The capability-aggregated rule set is now injected at every production executor construction site (adapter-server `createRuntimeContext`, CLI `dev` and `exec`). Non-breaking: when `rules` is omitted (tests, minimal setups) behavior is unchanged.

- db10790: feat(core): wire execute_action + trigger_flow rule effects (Spec 23 §1.1, phase 3)

  Final phase of wiring `defineRule()` effects into the action-execution path (phase 1 block/warn/enrich #460, phase 2 require_approval + record-state #461). Adds the two **post-commit side-effect** effects.

  - New `TriggerFlowEffect` (`{ type: "trigger_flow", flow, input? }`) on the `RuleEffect` union; the rule engine collects `execute_action` and `trigger_flow` effects into `RuleEvalOutput.actions` / `RuleEvalOutput.flows`.
  - The executor runs both **after the write is durable** (alongside the event flush, root / non-transactional only — a nested action inside a parent transaction must not fire side effects before the parent commits), **best-effort**: a side-effect failure logs and never fails the already-committed action.
    - `execute_action` re-invokes the named action via the executor (`params` default to the triggering action's input).
    - `trigger_flow` starts a durable Flow via a new optional `flowEngine` (`ActionFlowStarter`, a structural subset of `FlowEngine`) + late-binding `executor.setFlowEngine()` seam; per Spec 26 §2.2 the Flow owns its own Saga/failure policy and is not compensation-coupled to the triggering action (`input` defaults to the action input). When no flow engine is wired, the effect is logged and skipped.
  - Wiring: CLI `dev` calls `executor.setFlowEngine(flowEngine)`. `RuntimeContextOptions` gains an optional `flowEngine` the boot path can inject. (The server does not yet aggregate flows at the runtime-context layer, so server-side `trigger_flow` is wired through this seam — building/aggregating the server flow engine is a follow-up.)

  Tests: `action-engine-rule-integration.test.ts` adds execute_action (runs post-commit with params), trigger_flow (starts the flow; `effect.input` override; no-engine skip), and a blocked-action-skips-side-effects case — all through the real executor. Non-breaking. No `any`/`!`.

### Patch Changes

- f0aa51c: Surface the evolution pipeline's per-proposal pre-analysis to human reviewers
  (Spec 55 §7.3).

  The evolution cycle generates a pre-analysis envelope (dedup / conflict / impact
  / backtest) for every proposal it surfaces (`EvolutionCycleResult.proposalAnalyses`),
  but it was DROPPED when those proposals were persisted as governance drafts — so
  the reviewer never saw the "why" (evidence / estimated impact / backtest delta /
  rationale) behind an AI-surfaced change. This change closes that seam, additively:

  - `ProposalDefinition` gains an OPTIONAL `analysis?: ProposalPreAnalysisResult`
    field carrying the read-only pre-analysis. Reuses the existing
    `ProposalPreAnalysisResult` type — no parallel shape.
  - `CreateProposalOptions` gains a matching OPTIONAL `analysis` that
    `ProposalEngine.createProposal` stores verbatim onto the draft.
  - `persistCycleProposalsAsDrafts` accepts the cycle's `proposalAnalyses` and
    attaches each envelope to its draft, keyed by `proposalId` (the source cycle
    proposal's id). Omitted when absent or unmatched — never fabricated.
  - The on-demand `POST /api/evolution/run-cycle` route and the evolution cadence
    wiring forward `proposalAnalyses` so the metadata is attached live.
  - The proposal read endpoints (`GET /api/proposals`, `GET /api/proposals/:id`)
    serialize the new `analysis` field for the review UI.

  Strictly additive and read-only: this metadata never affects dedup, validation,
  approval, or graduation. Drafts still land in `draft` status and the human
  approval gate is unchanged — only strengthened by giving the reviewer the
  evidence behind the proposal.

- 3b59ddd: fix(core,adapter-server): rule_block policy text survives batch production sanitization

  `extractErrorFromResult` in the batch action engine now threads the engine-stamped `data.context.constraint` marker (e.g. `"rule_block"`) onto `BatchFailedItem.error.constraint` (additive, optional) — including through the `all_or_nothing` abort path. `sanitizeBatchResult` (shared by REST `POST /api/actions/batch` and GraphQL `Mutation.batch_actions`) uses that server-controlled marker to keep a rule `block` reason — the rule author's user-facing policy text — verbatim in production, mirroring the single-action route's exemption. All other failures are still flattened to the generic message.

- 51ecca1: Add `createEvolutionScheduler` (Spec 55 §7) — an opt-in cadence engine for the
  evolution cycle. It runs a caller-provided tick (typically "run one cycle →
  persist its proposals as governance DRAFTS") on a fixed interval, with
  non-overlapping ticks, an interval floor (`MIN_INTERVAL_MS`), caught tick errors,
  and `start`/`stop`/`runOnce` lifecycle. It is inert until started and produces
  DRAFTS only — approval and graduation stay human-gated. Exported from
  `@linchkit/core/server`.

  `@linchkit/cap-adapter-server` wires it as an opt-in server cadence
  (`EVOLUTION_CADENCE_INTERVAL_MS`, off by default; `EVOLUTION_CADENCE_TENANT_IDS`
  to scope per tenant), started/stopped with the server lifecycle. Its
  `@linchkit/core` peer range is also bumped to `>=0.3.0 <0.4.0` — the adapter now
  imports core/server exports (this scheduler, plus the G-series materialize/cycle
  helpers) that only exist from core 0.3.0, so the old `^0.2.0` range would permit
  a broken install against a core that lacks them.

- d6b250d: fix: deliver action-driven SSE events for CRUD writes

  CRUD actions emitted `record.created`/`updated`/`deleted` with a `schema` payload
  field but no `entity`, so the action-engine event flush set the bus `EventRecord`'s
  `entity` to `undefined` and `SubscriptionManager.dispatchEvent` dropped the event —
  action-driven create/update/delete never reached SSE subscribers. CRUD actions now
  emit the canonical `entity` field (keeping `schema` as a legacy alias), and the
  event flush falls back to `payload.schema` when `entity` is absent (#482).

- 9f00487: feat(core,adapter-server): `strictExecutionDryRun` feature flag — opt-in gate that escalates execution dry-run findings from warnings to blocking validation errors (Spec 70 P5a, #522)

  `EnvironmentFeatureFlags.strictExecutionDryRun` exposes the existing Phase 5
  warn→block escalation as a configurable flag. Unlike `strictCompatibility` /
  `strictGeneratedContract` it is **opt-in everywhere — NOT derived from
  `isProduction`**: the dry-run depends on external sandbox infrastructure, so
  auto-blocking in prod on an un-configured or flaky sandbox would wedge
  graduation. It defaults to `false` in every environment and flips on only via
  the explicit `LINCHKIT_STRICT_EXECUTION_DRY_RUN=1` override (mirroring the
  materialize-path `LINCHKIT_EXECUTION_DRY_RUN=1` opt-in), once an operator has
  confirmed the sandbox is healthy. Infra failures (`infra_error`) remain
  warnings regardless of the flag.

  adapter-server threads the flag from `detectEnvironment().features` into the
  proposal-validation context next to the other strict flags, so submit-time
  Phase 5 honors it end-to-end.

- 5f9ff43: Wire the Phase 4 generated-source contract gate to the environment (Spec 55 §7,
  Spec 09). The validator (`validatePhase4`) and its `strictGeneratedContract`
  gating already existed in core, but the flag was never reachable from the
  deployment environment — so production could never actually block a
  contract-violating AI-generated `generatedSource`, it only ever warned.

  `EnvironmentFeatureFlags` gains `strictGeneratedContract`, derived from
  `isProduction` (the same expression as `strictCompatibility`, so the two Phase 3
  and Phase 4 gates move in lock-step — production and staging block, development
  stays warn-only). The adapter-server now threads
  `environment.features.strictGeneratedContract` through `mountProposalAPI` into the
  `ValidationContext`, so proposal validation flips Phase 4 findings from
  non-blocking warnings to blocking errors in production-like environments. No
  behavior change in development.

- Updated dependencies [d3bbc69]
- Updated dependencies [aa4fe90]
- Updated dependencies [74ea5ba]
- Updated dependencies [f0aa51c]
- Updated dependencies [0357153]
- Updated dependencies [3b59ddd]
- Updated dependencies [a41b02f]
- Updated dependencies [7bc18f3]
- Updated dependencies [833e1ad]
- Updated dependencies [ee51432]
- Updated dependencies [f86561b]
- Updated dependencies [6ba3f7e]
- Updated dependencies [64ad4c0]
- Updated dependencies [738d9e9]
- Updated dependencies [4c19796]
- Updated dependencies [eae84e7]
- Updated dependencies [efdfe74]
- Updated dependencies [30f08e7]
- Updated dependencies [f191193]
- Updated dependencies [51ecca1]
- Updated dependencies [e91e3f2]
- Updated dependencies [745debd]
- Updated dependencies [4b4f259]
- Updated dependencies [ca5417e]
- Updated dependencies [bb2ec5e]
- Updated dependencies [587f2c9]
- Updated dependencies [13696ca]
- Updated dependencies [d844445]
- Updated dependencies [4475a69]
- Updated dependencies [13696ca]
- Updated dependencies [59aea2e]
- Updated dependencies [e969502]
- Updated dependencies [e13e172]
- Updated dependencies [7929b5b]
- Updated dependencies [d817334]
- Updated dependencies [13696ca]
- Updated dependencies [7ab2986]
- Updated dependencies [e4e6a18]
- Updated dependencies [94d6962]
- Updated dependencies [90bd84b]
- Updated dependencies [0802b40]
- Updated dependencies [5108a65]
- Updated dependencies [106e926]
- Updated dependencies [ebac7d6]
- Updated dependencies [d6b250d]
- Updated dependencies [9f00487]
- Updated dependencies [5f9ff43]
- Updated dependencies [5d8d2d5]
- Updated dependencies [e1f16e8]
- Updated dependencies [9626920]
- Updated dependencies [a1f2bba]
- Updated dependencies [685ccc1]
- Updated dependencies [76511f7]
- Updated dependencies [db10790]
  - @linchkit/cap-ai-provider@2.0.0
  - @linchkit/core@0.3.0
  - @linchkit/cap-dry-run@1.0.0
  - @linchkit/cap-adapter-ag-ui@2.0.0

## 1.0.0

### Minor Changes

- b117c2c: Initial public release — M3 milestone

  - Runtime Entity Overlay (Spec 59): JSONB \_extensions, overlay registry, GraphQL hot-reload
  - AI Workspace (Spec 60): linch doctor, linch info, linch agents-md, linch mcp-dev
  - Core i18n: capability-owned translations, resolveLabel for CLI/MCP
  - Publishing infrastructure: tsup builds, OCA source addons, changesets

### Patch Changes

- Updated dependencies [b117c2c]
  - @linchkit/core@0.2.0
