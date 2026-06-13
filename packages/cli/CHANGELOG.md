# @linchkit/cli

## 0.3.0

### Minor Changes

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

- 34800cb: Wire the Spec-55 evolution loop's dormant proposal generation into the live `linch dev` boot path. The dev runtime now passes `ontology`, `translatorRegistry`, `proposalCapability`, and a dedup+impact pre-analysis pipeline to `createEvolutionRuntime()`, so surfaced insights are translated into analyzed proposals instead of dead-ending at the Insight stage. Proposals appear strictly as data on the cycle result — no graduation (file write / git commit) is wired.

### Patch Changes

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

- 0f491a8: Register capability-defined event handlers in the `linch dev` boot path.

  `collect-capabilities` already gathered each capability's `eventHandlers`, but the dev wiring never registered them onto the `EventHandlerRegistry` — it only used the registry for the OutboxWorker and a health check. As a result, capability `defineEventHandler` reactions never fired under `linch dev`. The handlers are now threaded through `WireDevEnginesInput` and registered onto the registry right after the event bus is created (mirroring the `linch events` bootstrap path), with the existing skip-on-duplicate guard.

- 1780b57: Wire an in-process `SyncFlowEngine` into the `createDevApp` / `createRuntimeContext` boot path so a `trigger_flow` rule effect actually starts its flow. Previously this DB-free, in-process path never aggregated capability flows nor built a flow engine, so the effect silently logged + skipped. `createRuntimeContext` now accepts `flows` and builds a default sync engine from them; `assembleDevSchema` / `extractCapabilities` aggregate `cap.flows`. An externally injected `flowEngine` (e.g. the durable Restate engine wired by `linch dev`) still takes precedence and is unaffected.

  Also forward the Saga compensation idempotency key (Spec 26 §3.2) from the flow step context into `executor.execute` in both flow-engine wiring sites (`createRuntimeContext` and `dev-wiring.ts`), so a retried compensating action started through the sync flow engine is not executed twice. (#476)

- e1f16e8: feat(spec-21): declarable, anti-spoof-clamped capability trust tiers (#122)

  Capabilities may now self-declare a `trustLevel` on their `CapabilityDefinition` and in `capability.json` (top-level `trustLevel`). The declaration is anti-spoof: a new `computeEffectiveTrust` helper resolves the effective tier as `clamp(declared ?? inferred, ceiling = name-inferred)`, so a declaration can only ever LOWER (or equal) the tier the package name justifies — never raise it (a `linchkit-cap-*` package declaring `official` is clamped back to `community`). Opting into a stricter tier than the name justifies is honored. Name-based inference (`@linchkit/*` → `official`, `linchkit-cap-*` → `community`, else `unverified`) plus the clamp now live in `@linchkit/core` as the single source of truth, deduplicating the copies previously embedded in the CLI `install` and `publish` commands. The resolved effective tier continues to gate `systemPermissions` via `checkTrustPermissions`; undeclared capabilities behave exactly as before. The `verified` tier is registry-assigned and remains deferred to #85 (never inferred). Non-breaking — `trustLevel` is optional everywhere.

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

- Updated dependencies [aa4fe90]
- Updated dependencies [74ea5ba]
- Updated dependencies [f0aa51c]
- Updated dependencies [0357153]
- Updated dependencies [3b59ddd]
- Updated dependencies [a41b02f]
- Updated dependencies [7bc18f3]
- Updated dependencies [833e1ad]
- Updated dependencies [ee51432]
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
- Updated dependencies [38b61c5]
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
  - @linchkit/core@0.3.0
  - @linchkit/devtools@0.3.0
  - @linchkit/cap-migration@2.0.0
  - @linchkit/cap-flow-restate@2.0.0

## 0.2.0

### Minor Changes

- b117c2c: Initial public release — M3 milestone

  - Runtime Entity Overlay (Spec 59): JSONB \_extensions, overlay registry, GraphQL hot-reload
  - AI Workspace (Spec 60): linch doctor, linch info, linch agents-md, linch mcp-dev
  - Core i18n: capability-owned translations, resolveLabel for CLI/MCP
  - Publishing infrastructure: tsup builds, OCA source addons, changesets

### Patch Changes

- Updated dependencies [b117c2c]
  - @linchkit/core@0.2.0
  - @linchkit/devtools@0.2.0
  - @linchkit/cap-flow-restate@1.0.0
  - @linchkit/cap-migration@1.0.0
