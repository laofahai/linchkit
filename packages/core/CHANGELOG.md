# @linchkit/core

## 0.3.0

### Minor Changes

- 74ea5ba: Persist `ctx.meta` across approval suspend/resume (Spec 65 §14 M6). Approval-gated actions now carry their original ExecutionMeta through the suspend boundary so handlers see the same `source_view` / `triggered_by` / `bulk` context on the approved rerun as on the original submission. New `ApprovalRequest.meta` field; new `_linchkit.approvals.meta` jsonb column; `createApprovalEngine()` accepts `configRegistry` for resolving `system:execution.meta.maskedKeys`. Meta is sanitized at persist (`_`-prefixed system keys stripped per §4.4; configured masked keys redacted to `***` per §10.3) so the approvals table never holds unredacted secrets and stale `_execution_id` / `_channel` cannot leak into CommandLayer middleware on replay.
- 64ad4c0: feat(core): EventHandlerContext exposes the originating action's `meta` (Spec 65 §7)

  EventHandlers now receive `ctx.meta: ExecutionMeta` populated from the action that
  emitted the event, so handlers can read flags like `skip_notifications` or `dry_run`
  and gate side effects accordingly. Meta is delivery-time only — `EventRecord` carries
  an optional `meta` field that is intentionally NOT persisted (both DB-side persistence
  sites pick fields explicitly). Handlers triggered without an originating action (system
  heartbeats, OutboxWorker retries) get an empty `ExecutionMeta` so `ctx.meta.get(...)`
  returns `undefined` rather than throwing. Existing handlers that don't reference `meta`
  keep working unchanged.

- 4c19796: Add InsightEngine and EvolutionCycle for end-to-end evolution pipeline (Spec 55 MVP). New types: Insight, InsightEvidence, InsightPromotionConfig, InsightEngine, EvolutionCycle. New factories: createInsightEngine(), createEvolutionCycle(). Exports MemoryEngine and InMemoryMemoryStore from life-system module.
- 4b4f259: feat(core): idempotency cache key now folds in behavior-affecting `ctx.meta` keys (Spec 65 §5)

  Two requests with the same idempotency key but different behavior-affecting meta
  (`dry_run`, `skip_notifications`, `bulk`, any `default.*`) no longer shortcircuit to
  the cached result — they re-execute, since meta changes the operation's intent.
  Observational meta (`lang`, `tz`, `source_view`, …) and `_`-prefixed system keys
  are excluded from the hash so they do not fragment the cache. Effective key is
  unchanged for callers that pass no behavior-affecting meta.

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

- 5108a65: feat(core): rule conditions resolve `meta.*` field paths against `ExecutionMeta` (Spec 65 §6)

  `RuleEvalInput` gains an optional `meta?: ExecutionMeta` field, threaded into
  the per-rule `ConditionContext`. Field paths in rule conditions that begin with
  `meta.` now resolve against `ctx.meta?.get(...)` instead of the entity record,
  with one level of dotted nesting after the meta key (`meta.source.channel`).
  Missing keys return `undefined` — same shape as missing entity fields, so
  existing rules without `meta.*` references keep working unchanged.

### Patch Changes

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

## 0.2.0

### Minor Changes

- b117c2c: Initial public release — M3 milestone

  - Runtime Entity Overlay (Spec 59): JSONB \_extensions, overlay registry, GraphQL hot-reload
  - AI Workspace (Spec 60): linch doctor, linch info, linch agents-md, linch mcp-dev
  - Core i18n: capability-owned translations, resolveLabel for CLI/MCP
  - Publishing infrastructure: tsup builds, OCA source addons, changesets
