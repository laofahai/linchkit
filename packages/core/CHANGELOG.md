# @linchkit/core

## 0.3.0

### Minor Changes

- aa4fe90: Add in-house "Langfuse-class" AI tracing (Spec 69 Phase 3, PR-1): trace data
  model + provider instrumentation.

  `@linchkit/core`:

  - New `AITrace` / `AIGeneration` / `AITraceContext` data model plus
    `RedactionPolicy`, `AITraceSamplingConfig`, and the `AITraceSink` interface
    (`packages/core/src/observability/ai-trace.ts`).
  - `redactPromptMessages` / `redactContent` helpers (built on the existing
    masking engine) supporting `none` / `mask` / `hash` / `drop` modes, plus
    `shouldSample` for sampling.
  - `InMemoryAITraceStore` ring-buffer sink mirroring `AIActionAuditStore`
    (capacity trim, tenant isolation, aggregate roll-up) and a module-level
    `getAITraceSink()` / `setAITraceSink()` / `resetAITraceSink()` registry
    mirroring the observability registry
    (`packages/core/src/observability/ai-trace-store.ts`).
  - Optional non-breaking `trace?: AITraceContext` field on
    `AICompletionOptions`.

  `@linchkit/cap-ai-provider`:

  - `createAIService` now records one `AIGeneration` per `complete()` call —
    opening a tracer span and writing to the active `AITraceSink` with redaction
    (mask for production origin, verbatim for eval origin) and sampling applied.
    The provider error string is redacted with the SAME policy as
    prompts/completions (and length-capped) so a 4xx that echoes the request body
    or auth headers cannot leak under the production `mask` policy.
  - A parent `AITrace` wraps `executeWithFallback` so retries + fallback land
    under one trace. The sampling decision is resolved ONCE per trace and threaded
    into every child generation, so a fractional rate can never sample a
    generation in under a sampled-out parent (or vice-versa). All span/sink calls
    are strictly non-throwing: a misbehaving tracer or sink never breaks a real AI
    call.
  - A fallback-served success now records `fallbackUsed` on its generation.
  - The streaming path records a best-effort `partial` generation at stream open
    (token-accurate streaming accounting is deferred to a later PR).
  - `resolveIntent` accepts and forwards an optional `trace` context; the intent
    eval scenario attaches `origin: "eval"` provenance per fixture.

- 74ea5ba: Persist `ctx.meta` across approval suspend/resume (Spec 65 §14 M6). Approval-gated actions now carry their original ExecutionMeta through the suspend boundary so handlers see the same `source_view` / `triggered_by` / `bulk` context on the approved rerun as on the original submission. New `ApprovalRequest.meta` field; new `_linchkit.approvals.meta` jsonb column; `createApprovalEngine()` accepts `configRegistry` for resolving `system:execution.meta.maskedKeys`. Meta is sanitized at persist (`_`-prefixed system keys stripped per §4.4; configured masked keys redacted to `***` per §10.3) so the approvals table never holds unredacted secrets and stale `_execution_id` / `_channel` cannot leak into CommandLayer middleware on replay.
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

- 7bc18f3: fix(spec-21): make the core ↔ capability compatibility check fire for shipped addons (#122)

  The Spec 21 / #122 compatibility check was inert for every real addon: shipped
  `package.json` files declare `linchkit.minCoreVersion`, a third key the metadata
  schema did not recognize (so it was silently stripped), and the runtime
  `CapabilityDefinition.coreVersion` was never populated from disk metadata — so the
  boot-time `enforceCoreCompatibility` always saw `undefined` and checked nothing.

  - **Schema reconciliation**: `capabilityMetadataSchema.linchkit` now recognizes the
    deprecated `minCoreVersion` alias alongside `coreVersion` and `minVersion`.
    `coreVersionRangeOf` resolves the effective range with precedence
    `coreVersion ?? minVersion ?? minCoreVersion`; `minVersion` and `minCoreVersion`
    are normalized to a `>=` range (a value that is already a range is kept verbatim).
  - **Runtime population**: `scanAddonsPath` now populates `CapabilityDefinition.coreVersion`
    from the scanned addon's `package.json` `linchkit` block via `coreVersionRangeOf`, so
    the boot check has a real range to evaluate. An explicit range on the definition still wins.

  Strict enforcement remains hard-gated off (`STRICT_COMPAT_READY=false` in `dev.ts`):
  with core `VERSION` `0.0.1` vs addon ranges like `^0.2.0`, this surfaces WARN lines,
  never a throw. Non-breaking — all three `linchkit` version keys are optional.

- ee51432: feat(deployment): DeployBuilder now aborts subprocesses on timeout via AbortSignal.

  `ProcessExecutor` signature gained an optional fourth parameter `options?: { signal?: AbortSignal }`. Custom executors implementing this type should forward the signal to their spawn mechanism (e.g., `child_process.spawn`'s `signal` option or `Bun.spawn`'s `signal` option) so timed-out processes get SIGTERM'd instead of leaking as orphans. Existing executors that ignore the new parameter remain functionally compatible but will continue to leak subprocesses on timeout.

  The internal `withTimeout` helper now accepts a `(signal) => Promise<T>` callback rather than a bare `Promise<T>`. The default `Bun.spawn`-backed executor forwards the signal and translates an aborted run into a clear `Subprocess aborted` error instead of the previous opaque `exit 143: <empty>`.

  Fixes #361.

- 64ad4c0: feat(core): EventHandlerContext exposes the originating action's `meta` (Spec 65 §7)

  EventHandlers now receive `ctx.meta: ExecutionMeta` populated from the action that
  emitted the event, so handlers can read flags like `skip_notifications` or `dry_run`
  and gate side effects accordingly. Meta is delivery-time only — `EventRecord` carries
  an optional `meta` field that is intentionally NOT persisted (both DB-side persistence
  sites pick fields explicitly). Handlers triggered without an originating action (system
  heartbeats, OutboxWorker retries) get an empty `ExecutionMeta` so `ctx.meta.get(...)`
  returns `undefined` rather than throwing. Existing handlers that don't reference `meta`
  keep working unchanged.

- 738d9e9: Bridge the Spec-55 evolution cycle into the governance review pipeline (on-demand). The evolution `runCycle()` was never invoked at runtime and its proposals were transient — they never reached human review. New `persistCycleProposalsAsDrafts` helper (`@linchkit/core`) maps each cycle `ProposalDefinition` to a governance `draft` via `ProposalEngine.createProposal`, deduped against the already-pending set (capability + change names) so re-running a cycle is idempotent. New `POST /api/evolution/run-cycle` endpoint (`@linchkit/cap-adapter-server`) runs one cycle on demand through CommandLayer (permission slot never skipped; 501 when the evolution runtime is absent, 503 when the command layer is absent) and persists the results as drafts, returning `{ created, deduped, total, createdIds }`.

  Strictly drafts-only: nothing is submitted, validated, approved, committed, deployed, or graduated, and there is no scheduler — invocation cadence and graduation (to files/PR) remain deferred. Pre-analysis envelopes are not attached (no slot on the proposal shape; out of scope).

- 4c19796: Add InsightEngine and EvolutionCycle for end-to-end evolution pipeline (Spec 55 MVP). New types: Insight, InsightEvidence, InsightPromotionConfig, InsightEngine, EvolutionCycle. New factories: createInsightEngine(), createEvolutionCycle(). Exports MemoryEngine and InMemoryMemoryStore from life-system module.
- f191193: G5 Phase 1 — implement the `CodeGenerationProvider` seam.

  `@linchkit/core` previously declared a `CodeGenerationProvider` interface
  ("implemented by cap-ai-provider") but no implementation existed and the type was
  not exported from any public barrel. This adds:

  - `@linchkit/core/server` now exports the `CodeGenerationProvider`,
    `CodeGenerationResult`, `ProjectContext`, and `QualityGateRunner` types so a
    capability can implement the seam.
  - `@linchkit/cap-ai-provider` exports `createCodeGenerationProvider(ai, options)`
    — a thin adapter over the configured `AIService` (GLM/zhipu/etc. per
    `linchkit.config`) that turns a prompt (+ optional context) into generated
    TypeScript source.

  This is the foundation for AI code generation of the irreducibly-code parts of a
  proposal (action / event-handler / flow logic bodies). It only PRODUCES candidate
  source as a string — it never writes files, runs code, or touches the approval /
  graduation path. Generated source still flows through validation and double human
  review (draft + graduation PR) before it can land.

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

- e91e3f2: G5 Phase 2 + 3 — proposal code materialization + build-gate (engine).

  - **Materializer (P3):** `materializeProposalChanges({ proposal, provider, qualityGate?, maxRetries?, context? })` generates TypeScript source for the irreducibly-code parts of a proposal (action / event / flow logic bodies) via a `CodeGenerationProvider`, attaching it to each change as the new optional `ProposalChange.generatedSource`. Declarative targets (entity / rule / view / state / overlay) and deletes are skipped. Generate → quality-gate → retry-with-feedback (default 3 attempts). Returns a COPY — never mutates the input, never writes files, runs code, approves, or graduates.
  - **Build gate (P2):** `checkSourceSyntax()` / `createSyntaxQualityGate()` validate generated source SYNTACTICALLY via Bun's transpiler (no project-aware type resolution — that would false-positive on project symbol references; left to the graduation PR's CI). `validatePhase2()` runs this over a proposal's `generatedSource` and is now wired into `validateProposal` (previously a skipped stub). Warn-only by default; `ValidationContext.strictGeneratedBuild` escalates to blocking. All-declarative proposals still see Phase 2 "skipped" — existing callers are unaffected.
  - New `@linchkit/core/server` exports: `materializeProposalChanges`, `isMaterializable`, `validatePhase2`, `checkSourceSyntax`, `createSyntaxQualityGate` (+ types).

  SAFETY: candidate source only — it flows through validation (Phase 2) and double human review (draft + graduation PR) before it can land. "AI never modifies production directly." Not yet wired into a live HTTP/draft path (a thin follow-up).

- 745debd: Add validation Phase 4 — generated-source contract check (G5). `validatePhase4`
  statically (execution-free) verifies that AI-materialized `generatedSource`
  actually defines the change's declared target/name (right `define*()` call,
  references its name, imports `@linchkit/core`). Warn-only by default; gated to
  block via `ValidationContext.strictGeneratedContract`. Wired into
  `validateProposal` (was a skipped stub); all-declarative proposals stay
  "skipped". No generated code is ever executed — an execution-based dry-run
  (sandboxed handler run) is intentionally out of scope.
- 4b4f259: feat(core): idempotency cache key now folds in behavior-affecting `ctx.meta` keys (Spec 65 §5)

  Two requests with the same idempotency key but different behavior-affecting meta
  (`dry_run`, `skip_notifications`, `bulk`, any `default.*`) no longer shortcircuit to
  the cached result — they re-execute, since meta changes the operation's intent.
  Observational meta (`lang`, `tz`, `source_view`, …) and `_`-prefixed system keys
  are excluded from the hash so they do not fragment the cache. Effective key is
  unchanged for callers that pass no behavior-affecting meta.

- ca5417e: Close the residual record-state guard TOCTOU window with a row-level lock (#470).

  PR #469 moved `block` / `require_approval` guard-rule evaluation inside the write
  transaction, but under PostgreSQL READ COMMITTED a plain `SELECT` guard read +
  the write were still not atomic — a concurrent commit could land between them.

  `DataQueryOptions` gains an opt-in `forUpdate` flag. The Drizzle provider honors
  it with `SELECT … FOR UPDATE`, and the in-transaction guard re-check now sets it
  so the guarded row is pinned from the read until commit: a concurrent writer
  blocks instead of slipping a state change past the guard. The InMemoryStore is
  single-threaded and already serialized, so it no-ops the flag. No behavior change
  for existing callers — `forUpdate` defaults to off.

- bb2ec5e: fix(core): evaluate record-state guard rules inside the write transaction
  (#462 / #466 TOCTOU hardening).

  For a top-level transactional action, a record-state `block` / `require_approval`
  rule is now re-evaluated against the transactional snapshot inside `runHandler`,
  immediately before the write — the same snapshot the write commits to. This
  closes the integrity-critical TOCTOU window: a concurrent commit landing between
  the pre-write rule read and the write can no longer let a now-blocked /
  now-approval-required action write through. The pre-write Step 4c pass is
  retained (it derives `enrich` / `warn` / post-commit side effects and provides
  an early rejection); the in-transaction re-check is the authoritative guard.

  Mirrors the in-transaction relocation field-lock enforcement took in #203.
  Nested actions (already reading the parent transaction) and non-transactional
  actions are unchanged. The reverse direction — a guard that fired on a
  now-stale pre-write snapshot but would not on the fresh one — still early-rejects
  pre-write; that is a retryable false-rejection, not a write-integrity violation,
  consistent with field-lock's pre-transaction preflight.

  Scope: this collapses the wide pre-write window (Step 4c ran before validation,
  the state-machine check, and handler setup) by moving the guard read inside the
  transaction adjacent to the write. It does not, by itself, make read+write
  atomic under PostgreSQL READ COMMITTED — full closure needs row-level locking
  (`SELECT … FOR UPDATE`) or a snapshot-stable isolation level, neither of which
  the DataProvider interface exposes today (tracked as #466 follow-up). The same
  residual applies to field-lock #203. Fully closed for the InMemoryStore and
  under serializable isolation.

- 587f2c9: feat: MCP adapter auto-injects `_mcp_client_id` into ExecutionMeta (Spec 65 §3.3)

  The MCP adapter now stamps the authenticated client's registration ID into
  `ctx.meta._mcp_client_id` at action dispatch, so handlers, rules, and
  EventHandlers can attribute MCP-originating calls to a specific client. Core
  gains a `systemMeta?: Record<string, unknown>` option on `CommandExecuteOptions`
  / `ExecuteOptions` to allow trusted adapters to seed `_`-prefixed system keys
  (framework reserved keys `_channel` / `_execution_id` / `_depth` /
  `_source_action` are protected; non-`_` keys are silently dropped). When no
  authenticated client is present (stdio / open-access / simple-bearer-token),
  no fake ID is invented — the field is omitted.

- 13696ca: feat(adapter-mcp): `resolve_schema_intent` MCP tool — NL→governed proposal (#583)

  MCP agents can now send a natural-language utterance and get a governed proposal draft, the same capability the HTTP route provides — closing the "every channel" gap for 说 → 有. Adds `proposalEngine` to `TransportContext` and forwards it through the MCP factory, which also activates `create_proposal` (previously dormant in the dev MCP path because the engine never reached the adapter).

- d844445: Add `MigrationCoordinator` core engine (Spec 12 §5 "DB Migration"). Coordinates forward/reverse DB migrations around a release.

  Applied-vs-pending discovery is **DB-driven, not journal-driven**. The coordinator consumes a REQUIRED injected `appliedMigrationsReader: () => Promise<ReadonlySet<string>>` that reports the migration tags ACTUALLY APPLIED to the target database (sourced from drizzle's `__drizzle_migrations` table). Drizzle's on-disk `meta/_journal.json` is the registry of every GENERATED migration and is deliberately NOT used to decide applied state. From this, `preFlight()` computes `pending = on-disk listing − DB-applied` (and `applied = on-disk listing ∩ DB-applied`), detects committed sibling `down.sql` artifacts, and classifies the release (safe/expand = ok, contract = warning, breaking or any missing `down.sql` = blocker unless `allowIrreversible` confirms manually). Because already-applied migrations are never in the pending set, a forward failure can never reverse a migration the DB already holds.

  `migrateForward()` applies pending migrations and best-effort reverses ONLY this run's pending migrations on failure (returns `aborted`, never throws); `migrateReverse(targetId?)` executes committed `down.sql` artifacts in reverse id order (exclusive `targetId` floor), refusing partial execution when a `down.sql` is missing. All I/O (the applied-migrations reader, forward apply, reverse SQL execution, dir listing) is injectable so the engine is unit-testable without a DB or disk; the reader has no journal-based default — omitting it throws a clear error. Migration ids/paths are validated against flag/path-traversal injection. Drizzle has no native `down`, so reverse migrations are realized via committed `NNNN_name.down.sql` siblings — the coordinator executes them and never generates DDL.

  cap-migration adds `runReverseMigration(db, { sqlPath })`, which reads a committed `down.sql` and executes it inside a transaction via `db.execute(sql.raw(...))`; it is the default reverse SQL executor the coordinator delegates to.

- 13696ca: feat(说 → 有): NL schema-intent drafts a governed `add_entity` proposal (#575)

  The schema-intent resolver now turns an utterance like "增加一个商品管理" into a governed `add_entity` ProposalDraft (instead of `no_match`). A new `schema-intent-entity-builder` validates the entity shape (snake_case name, no system-field collisions, valid field types/constraints, optional relation endpoints) and mints the draft; `POST /api/ai/resolve-schema-intent` persists it into the shared governed engine so it surfaces in the human-gated review pipeline. Works on an empty catalog (first entity), and surfaces requested-but-malformed relations as errors rather than silently dropping them.

- 7929b5b: feat(spec-55): ProposalFileWriter — persist approved Proposals to disk

  Closes the human-in-the-loop hand-off in the Spec 55 evolution loop. Once a Proposal reaches `status="approved"`, the new `ProposalFileWriter` writes its changes as TypeScript source files under `addons/<group>/cap-<short>/src/{rules,views,flows,entities,...}/_<proposal-id>.<kind>.ts` so the developer can review the diff in source control and rebuild. The `ProposalEngine` constructor gains an optional `onApproved` callback that consumers can wire to trigger the writer (or any other downstream persistence — Git PR, hot-reload, etc.). Failures in the callback are captured in `proposal.persistenceError` and do not roll back the approval status.

  BREAKING CHANGE: `ProposalEngine.approveProposal` is now async (returns `Promise<ProposalDefinition>` instead of `ProposalDefinition`) so the `onApproved` hook can be awaited. Direct callers must add `await`.

- d817334: feat(spec-55): ProposalGitCommitter — graduate approved Proposals to a GitHub PR

  Adds ProposalGitCommitter capability — graduates approved Proposals from on-disk files (via ProposalFileWriter) to a GitHub PR. The committer is a thin orchestrator: it derives a branch name from the proposal, creates the branch off the configured base, stages exactly the files written by ProposalFileWriter, commits with a structured message carrying `Proposal-ID` / `Source-Insights` trailers, pushes to the remote, and opens a PR via `gh`. Composes with `ProposalEngine.onApproved` hook — wiring is left to the caller so projects can stage or batch PRs. Subprocess runners are injectable for tests; the default implementation uses `Bun.spawn`. No breaking change.

- 13696ca: feat: graduate an NL-drafted relation as a first-class change (#580)

  `relation` is now a first-class graduable `ProposalChange`: added to `ProposalChangeTarget` and the `ChangeDefinition` union, wired into `ProposalFileWriter` (relations/ subdir, `defineRelation` factory), and classified additive/non-breaking by the impact analyzer. An `add_entity`-with-relation proposal now persists a SECOND `relation` change (the entity change stays a clean `EntityDefinition`) and graduates to BOTH `defineEntity()` and `defineRelation()` source.

- 7ab2986: feat(spec-55): RollbackInsightEmitter — surface rollback Insights from failed proposal effects (§7.7 Phase 2 downstream)

  Adds RollbackInsightEmitter — reads `proposal:effect:failed` signals emitted by ProposalEffectVerifier and surfaces one evidence-backed rollback `Insight` (tagged `"rollback_candidate"`) per failed proposal whose payload carries `rollback_candidate: true`. Emission is idempotent via a deterministic id (`rollback-insight:<proposalId>`), supports an optional `since` filter, and exposes a `getInsights()` accessor mirroring InsightEngine. Stays in scope: emits the Insight only — never auto-executes a rollback, invokes DeployRollbackOrchestrator, or creates a Proposal; rollback remains a separate human-approved Proposal. Intentionally NOT auto-wired.

- e4e6a18: Add the rollback Insight→Proposal translator (Spec 55 §7.7 Phase 2, Slice A).

  A `rollback_candidate`-tagged anomaly Insight (emitted by `RollbackInsightEmitter`
  when a merged Proposal fails its successMetric) is now translated into a
  governance-safe `status:"draft"` rollback `ProposalDefinition`. The draft carries
  a single `target:"revert"` change (with a fixed, validation-safe name `"revert"`)
  and an inverse `successMetric`, then flows through the existing Insight→Proposal
  pipeline to the HUMAN approval gate. The translator only produces a draft — it
  never invokes `DeployRollbackOrchestrator`, performs Git operations, or
  auto-executes a rollback.

  Supporting changes:

  - `ProposalChangeTarget` gains a `"revert"` member.
  - Phase-1 validation (`validatePhase1` / `validateProposal`) now skips the
    `MISSING_DEFINITION` requirement for `target:"revert"` changes (mirroring the
    existing `delete` skip), so a definition-less rollback draft passes validation
    and can reach the approval gate. The revert change name is a fixed
    `NAME_PATTERN`-valid identifier; the proposalId being reverted is carried in the
    change `diff` and the proposal's evidence sidecar (`evidence.context.revertProposalId`).
  - `ProposalFileWriter` skips `target:"revert"` changes (no source file to write)
    with a warning, mirroring how it skips `delete` operations.
  - `insightTranslatorKey()` routes tagged anomalies to `anomaly:rollback_candidate`
    without affecting ordinary anomaly insights.
  - The rollback evidence sidecar is now nested under `.context` and enumerable,
    matching `schemaNoViewTranslator`, so `ProposalGitCommitter` recovers the source
    insight id for the commit trailer / PR body and the sidecar survives `JSON.stringify`.

- 94d6962: Thread the merged commit SHA end-to-end through the rollback Insight→Proposal
  loop (Spec 55 §7.7), so a rollback executor can `git revert` the exact regressed
  commit instead of only naming the proposal.

  The SHA originates from `ProposalGitCommitter.commitAndOpenPR` (`commitSha`) and
  now flows: outcome payload (`ProposalOutcomePayload.mergedSha`, finally wiring
  the previously-orphaned `resolveMergedSha` capture) → effect-verification record
  and signal (`EffectVerificationRecord.mergedSha`) → rollback Insight evidence
  (`evidence.context.mergedSha`) → the revert `ProposalChange.revertSha` stamped by
  `rollbackCandidateTranslator`.

  Adds a pure, side-effect-free consumption helper
  `rollbackInputFromProposal(proposal)` that maps an APPROVED revert proposal to a
  `DeployRollbackOrchestrator` `RollbackInput`. It declines (returns `null`) for
  non-approved proposals or a missing SHA and never auto-executes — the rollback
  proposal stays `status: "draft"` and only graduates through the human approval
  gate.

- 5108a65: feat(core): rule conditions resolve `meta.*` field paths against `ExecutionMeta` (Spec 65 §6)

  `RuleEvalInput` gains an optional `meta?: ExecutionMeta` field, threaded into
  the per-rule `ConditionContext`. Field paths in rule conditions that begin with
  `meta.` now resolve against `ctx.meta?.get(...)` instead of the entity record,
  with one level of dotted nesting after the meta key (`meta.source.channel`).
  Missing keys return `undefined` — same shape as missing entity fields, so
  existing rules without `meta.*` references keep working unchanged.

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

- 5d8d2d5: Tenant-scope evolution sensor reads (Spec 55 §7, #500). Both the on-demand
  `POST /api/evolution/run-cycle` endpoint and the opt-in cadence pass a `tenantId`
  into the cycle's `SensorContext`, but the runtime query path ignored it — so a
  per-tenant cycle could observe global / cross-tenant data.

  `createDispatchQuery` now accepts an optional `tenantId` and applies it to all
  reads:

  - business reads pass it as `DataQueryOptions.tenantId` — the canonical,
    provider-enforced mechanism (Drizzle adds `WHERE tenant_id = …` only for tables
    with a tenant column, no-ops otherwise; InMemoryStore filters likewise);
  - `execution_log` reads pass it as `findMany({ tenantId })`. To make that
    meaningful, the action engine now stamps the CommandLayer-resolved
    `execOptions.tenantId` onto every `ExecutionLogEntry` it writes, so a
    per-tenant cycle reads only its own action history (both execution loggers
    already filter `findMany` by `tenantId`).

  `createEvolutionRuntime` gains an optional `queryFactory(tenantId?)` that builds a
  fresh, tenant-scoped query for each `runCycle` (consulted lazily — a caller's own
  `ctx.query` still wins). The dev wiring switches to this factory, so per-tenant
  on-demand and cadence cycles read only their own tenant's data. The static
  `query` option remains for backward compatibility; single-tenant / dev runs (no
  `tenantId`) are unscoped exactly as before. A set-but-blank `tenantId` is
  rejected at construction (the backends only scope on a truthy value, so a blank
  would silently read globally) — pass `undefined` to run intentionally unscoped.

- e1f16e8: feat(spec-21): declarable, anti-spoof-clamped capability trust tiers (#122)

  Capabilities may now self-declare a `trustLevel` on their `CapabilityDefinition` and in `capability.json` (top-level `trustLevel`). The declaration is anti-spoof: a new `computeEffectiveTrust` helper resolves the effective tier as `clamp(declared ?? inferred, ceiling = name-inferred)`, so a declaration can only ever LOWER (or equal) the tier the package name justifies — never raise it (a `linchkit-cap-*` package declaring `official` is clamped back to `community`). Opting into a stricter tier than the name justifies is honored. Name-based inference (`@linchkit/*` → `official`, `linchkit-cap-*` → `community`, else `unverified`) plus the clamp now live in `@linchkit/core` as the single source of truth, deduplicating the copies previously embedded in the CLI `install` and `publish` commands. The resolved effective tier continues to gate `systemPermissions` via `checkTrustPermissions`; undeclared capabilities behave exactly as before. The `verified` tier is registry-assigned and remains deferred to #85 (never inferred). Non-breaking — `trustLevel` is optional everywhere.

- 9626920: Implement proposal-validation Phase 3 (compatibility / breaking-reference checks, Spec 09 §4.5). `validatePhase3` inspects a proposal's delete/narrowing changes against the current meta-model (via the OntologyRegistry impact graph + field-reference scan) and flags breaking references: deleting a field still referenced by a view/rule, deleting an action/state with dependents, changing a field type, dropping a required field's default, or removing an enum value.

  Warn-only by default (does not affect `passed`); escalates to blocking errors when `strictCompatibility` is set. A new `features.strictCompatibility` env flag (default: true in production and staging, false in dev/test, mirroring `strictValidation`) wires this through `mountProposalAPI` so production and staging refuse proposals that break existing references while dev/test stays advisory. `ValidationContext` gains optional `ontology` + `strictCompatibility` fields; when absent, Phase 3 degrades to "skipped" so existing callers are unchanged.

- a1f2bba: feat(spec-21): capability ↔ core version-compatibility check (#122)

  Adds a boot-time compatibility check between capabilities and the running `@linchkit/core` version. Capabilities may declare a `coreVersion` semver RANGE (e.g. `^0.2.0`, `>=0.2.0 <0.4.0`) on their `CapabilityDefinition` and in `capability.json` (`linchkit.coreVersion`); when present it supersedes the now-deprecated `linchkit.minVersion`, which keeps working as a fallback. New `checkCoreCompatibility` / `enforceCoreCompatibility` helpers evaluate the resolved capability set against the core `VERSION`. `satisfiesVersionRange` now also parses whitespace-joined compound (AND) ranges. The CLI `dev` boot wires `enforceCoreCompatibility` after capability resolution in WARN-only mode (strict-refuse stays gated off until core `VERSION` is reconciled with addon declarations) so dev boot is never broken. `linch install` prefers `coreVersion ?? minVersion`. Non-breaking — both fields are optional.

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

- 0357153: feat(core): wire the capability resolver into the boot path + ship `starter-minimal` (Spec 14, #121, first slice)

  New `@linchkit/core/server` exports `mergeCapabilityPool(explicit, discovered)` (dedup by `name`, explicit wins) and `resolveCapabilities(explicit, discovered)` (runs `resolveDependencies` then `resolveAutoInstall` over the merged pool). The CLI gains `resolveActiveCapabilities(config)` in `load-config.ts`, and `linch dev` now activates the resolved set (config capabilities + `addons_path` discovery → pulled deps → auto-installed companions) instead of only the explicitly-listed ones. The other CLI commands are migrated in a fast-follow.

  New package `@linchkit/starter-minimal`: a baseline starter capability (`name: "starter-minimal"`) declaring `dependencies: ["cap-auth", "cap-permission"]`, so adding it to a project's config pulls in the auth + permission stack through the resolver.

- 3b59ddd: fix(core,adapter-server): rule_block policy text survives batch production sanitization

  `extractErrorFromResult` in the batch action engine now threads the engine-stamped `data.context.constraint` marker (e.g. `"rule_block"`) onto `BatchFailedItem.error.constraint` (additive, optional) — including through the `all_or_nothing` abort path. `sanitizeBatchResult` (shared by REST `POST /api/actions/batch` and GraphQL `Mutation.batch_actions`) uses that server-controlled marker to keep a rule `block` reason — the rule author's user-facing policy text — verbatim in production, mirroring the single-action route's exemption. All other failures are still flattened to the generic message.

- a41b02f: feat(cli): `linch exec` runs a named Action with input + ExecutionMeta (Spec 65 §3.5)

  ```
  linch exec approve_request --input '{"id":"pr_001"}' --meta '{"bulk":true}'
  ```

  The new `exec` command boots a minimal in-process runtime (config / registries
  / database / auth provider / ActionExecutor + CommandLayer; transports / Restate
  flow engine / AI service / sensors / cache manager are skipped — exec is one-
  shot) and dispatches the named Action through CommandLayer. `_`-prefixed meta
  keys are stripped pre-flight (Spec 65 §4.4) and JSON byte size is checked
  against `DEFAULT_META_MAX_BYTES` (8 KB; Spec 65 §10.2). Exit codes: 0 success,
  1 user input / validation errors, 2 action failure or bootstrap throw.
  Mutually exclusive `--input` / `--input-file` and `--meta` / `--meta-file`.

  Core also re-exports `DEFAULT_META_MAX_BYTES`, `MetaSizeError`,
  `createExecutionMeta`, `redactMetaForLog` as runtime exports so external
  runners (CLI, future scripting hosts) can construct meta safely.

- 833e1ad: fix: keep the browser-safe client barrel free of Node built-ins — `release-compatibility.ts` (re-exported by `exports/client/migration.ts`) no longer imports `node:fs/promises` / `node:path` at module top level. The two filesystem entry points (`checkReleaseCompatibility`, `analyzeFile`) load them lazily, and `crossPlatformBasename` is a pure string implementation. Importing `@linchkit/core` in the browser previously threw "Module fs/promises has been externalized" and blanked the UI.
- eae84e7: Extract the action-execution rule-evaluation decision (Step 4c) out of the
  ~2k-line `action-engine.ts` into a focused, unit-testable `evaluateActionRules`
  helper (`engine/action-rule-eval.ts`). Pure internal refactor — no public API or
  runtime behavior change; the executor keeps ownership of execution logging,
  approval-request creation, and the early returns. This is the first cut of the
  `action-engine.ts` split and sets up the in-transaction record-state evaluation
  hardening (issue #462).
- efdfe74: refactor(core): extract the post-commit rule side-effect runner
  (`execute_action` / `trigger_flow`) out of `createActionExecutor` into a new
  `engine/action-rule-effects.ts` (`runPostCommitRuleEffects`). It pairs with
  `action-rule-eval.ts` (decide) as the run-the-collected-effects half, and is
  the lowest-coupling slice of the executor body (best-effort, fires only after
  the write is durable). Pure code movement — zero behavior change (part of #462).
- 30f08e7: Fix the recorder↔verifier signal-type mismatch that silently broke the Spec 55
  §7.7 effect-verification loop. `ProposalOutcomeRecorder` emitted outcome signals
  with dot-delimited types (`proposal.outcome.<outcome>`) while
  `ProposalEffectVerifier` (and the rest of the life-system) queries the
  colon-delimited convention (`proposal:outcome:merged`). Because
  `InMemoryMemoryStore.getSignals` matches `Signal.type` by exact equality, the
  verifier never saw recorded merged outcomes, so the §7.7 effect-verification →
  rollback-insight → rollback-proposal loop never fired. The recorder now emits
  `proposal:outcome:*` (colons) to match the verifier's query and the repo-wide
  signal-type convention.
- 4475a69: Extend in-transaction record-state guard row-locking to nested actions (#473).

  PR #472 (#470) closed the record-state guard TOCTOU window for top-level
  transactional actions by acquiring a `SELECT … FOR UPDATE` row lock during the
  in-transaction guard re-check, gated on `useTransaction && !parentTxProvider`.
  Nested transactional actions (running inside a parent transaction) were excluded:
  their Step 4c guard read already uses the parent's transactional provider (so the
  snapshot is fresh) but it is a plain unlocked `SELECT`, leaving a residual
  read→write race under READ COMMITTED.

  The re-check gate is now `inTransaction`, so nested transactional actions also
  lock-pin their guarded row from the in-transaction re-check until the parent
  commits — uniform with top-level (Step 4c = unlocked preflight, in-tx re-check =
  authoritative locked decision). No change for non-transactional actions.

- 59aea2e: Propagate tenant and actor through `onComplete` flow chains (tenant-isolation fix).

  `processOnCompleteChains` started each downstream chained flow with `{ tenantId: undefined }` and no actor (the "inherit from context if available" comment was never implemented), so an `onComplete`-chained flow ran with no tenant scope and the default system actor — able to read/write records outside the originating tenant. `FlowInstance` now persists the run's `tenantId` and `actor` (both optional, backward-compatible), and `processOnCompleteChains` forwards them to the chained `startFlow`, mirroring the post-commit rule-effect path. No function signature change.

- e969502: Model state-machine dependency edges in the ontology impact graph. `extractDependencyEdges` now emits a `state_transition` edge (state → action) for each `StateDefinition.transitions[].action` and a `state_machine` edge (entity → state) for each entity field of `type: "state"` whose `machine` names a registered state machine. As a result `impactAnalysis` / `dependencyGraph` — and therefore proposal-validation Phase 3 — now detect that deleting an action used as a state transition, or a state machine attached to an entity, is a breaking change. Closes the documented Phase 3 under-reporting limitation.
- e13e172: Polish ProposalFileWriter — slug-based filenames (date + title + short-id) and opt-in Biome formatter via `formatter` option. Backwards-compatible: default behaviour unchanged.

  Generated TypeScript files now use a human-readable prefix of the form `_YYYYMMDD__<slugified-title>__<short-id>.<changeName>.<kindSuffix>.ts`. The date stamp comes from `proposal.createdAt` (UTC), the slug from `proposal.title` (lowercase a-z0-9, length-capped at 40, trailing dashes trimmed), and the short-id is the last 8 chars of `proposal.id` — matching the convention used by ProposalGitCommitter. Empty or special-char-only titles collapse to `_YYYYMMDD__<short-id>...`.

  A new `formatter` option opts source through a TypeScript formatter before the file is written:

  - `formatter: true` — pipe source through `bunx @biomejs/biome format --stdin-file-path=<path>` so generated files match the repo style and avoid churn on the developer's first save.
  - `formatter: (source, filename) => Promise<string>` — custom async formatter.
  - Omitted / `false` — no formatting (preserves prior behaviour, no breaking change).

  Formatter failures are swallowed and logged via `logger?.warn?.(...)`; the un-formatted source is written in their place so a stylistic step can never block code generation.

  Closes #368.

- 90bd84b: Rule conditions can now read the persisted record independently of caller input:
  `RuleConditionContext` / `ConditionContext` / `RuleEvalInput` gain an optional
  `record` field (the stored row backing `target`, which merges input over it),
  and declarative conditions resolve `record.*` field paths. Authority/guard rules
  should read trustworthy values from `record` — reading `target` is bypassable by
  input spoofing (e.g. approving a high-value record by sending `{ id, amount: 1 }`).

  Caveat: for `block`/`require_approval` effects gated on numeric thresholds
  (`gt`/`gte`/`lt`/`lte`), use a `CodeCondition` with an explicit fail-closed
  branch — when `record` is absent the declarative numeric operators return
  `false` (condition does not trigger), so a declarative threshold guard fails
  open. Declarative `record.*` is safe for informational/enrich rules and for
  `eq`/`neq`/`is_null`.

- 0802b40: Fail closed when a record-state guard rule can't read its row. Previously, when
  the record read inside action rule evaluation threw (transient / infra /
  partial-access error), evaluation silently degraded to input-only — which let a
  record-state `block` / `require_approval` rule be bypassed and the write proceed.

  Now a thrown read aborts the action when the applicable rule set contains a
  `block` or `require_approval` gate (the action fails with a clear
  "could not read … to evaluate guard rules" error). A read that _returns_ a falsy
  record (the row is genuinely absent — e.g. create-shaped input) is unchanged and
  still evaluates input-only; rule sets with only non-gate effects
  (`enrich` / `warn` / `execute_action` / `trigger_flow`) also keep the lenient
  input-only degrade. This is the first half of issue #462 Part 1; the
  in-transaction record-state evaluation (TOCTOU) hardening is tracked separately.

- ebac7d6: refactor(core): split the action-engine public type surface and stateless
  helpers out of `action-engine.ts`. The contract types (`DataProvider`,
  `ActionExecutor`, `ExecuteOptions`, `ActionExecutorOptions`, …) now live in
  `engine/action-engine-types.ts`, and the module-private helpers
  (`isExecutionMeta`, `fillMissingSystemKeys`, `checkAndRunFieldLockInterceptor`)
  moved into the existing `engine/action-helpers.ts`. `action-engine.ts`
  re-exports every type for backward compatibility, so all existing
  `from "@linchkit/core"` / `from "./action-engine"` imports keep working
  unchanged. Pure code movement — zero behavior change (part of #462).
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

## 0.2.0

### Minor Changes

- b117c2c: Initial public release — M3 milestone

  - Runtime Entity Overlay (Spec 59): JSONB \_extensions, overlay registry, GraphQL hot-reload
  - AI Workspace (Spec 60): linch doctor, linch info, linch agents-md, linch mcp-dev
  - Core i18n: capability-owned translations, resolveLabel for CLI/MCP
  - Publishing infrastructure: tsup builds, OCA source addons, changesets
