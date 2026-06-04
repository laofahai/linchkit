---
"@linchkit/core": minor
"@linchkit/cap-adapter-server": minor
"@linchkit/cli": patch
---

feat(core): wire execute_action + trigger_flow rule effects (Spec 23 §1.1, phase 3)

Final phase of wiring `defineRule()` effects into the action-execution path (phase 1 block/warn/enrich #460, phase 2 require_approval + record-state #461). Adds the two **post-commit side-effect** effects.

- New `TriggerFlowEffect` (`{ type: "trigger_flow", flow, input? }`) on the `RuleEffect` union; the rule engine collects `execute_action` and `trigger_flow` effects into `RuleEvalOutput.actions` / `RuleEvalOutput.flows`.
- The executor runs both **after the write is durable** (alongside the event flush, root / non-transactional only — a nested action inside a parent transaction must not fire side effects before the parent commits), **best-effort**: a side-effect failure logs and never fails the already-committed action.
  - `execute_action` re-invokes the named action via the executor (`params` default to the triggering action's input).
  - `trigger_flow` starts a durable Flow via a new optional `flowEngine` (`ActionFlowStarter`, a structural subset of `FlowEngine`) + late-binding `executor.setFlowEngine()` seam; per Spec 26 §2.2 the Flow owns its own Saga/failure policy and is not compensation-coupled to the triggering action (`input` defaults to the action input). When no flow engine is wired, the effect is logged and skipped.
- Wiring: CLI `dev` calls `executor.setFlowEngine(flowEngine)`. `RuntimeContextOptions` gains an optional `flowEngine` the boot path can inject. (The server does not yet aggregate flows at the runtime-context layer, so server-side `trigger_flow` is wired through this seam — building/aggregating the server flow engine is a follow-up.)

Tests: `action-engine-rule-integration.test.ts` adds execute_action (runs post-commit with params), trigger_flow (starts the flow; `effect.input` override; no-engine skip), and a blocked-action-skips-side-effects case — all through the real executor. Non-breaking. No `any`/`!`.
