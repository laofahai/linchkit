---
"@linchkit/core": minor
"@linchkit/cap-adapter-server": minor
"@linchkit/cli": patch
---

feat(core): wire business-rule evaluation into the action execution path (Spec 23 §1.1, phase 1)

`defineRule()` business rules are now evaluated during action execution. Previously the rule engine (`evaluateRules`) was a tested-but-unwired pure function: rule effects (block / warn / enrich / require_approval / execute_action) were collected by the engine but never applied when an action ran through the executor, so rules did not fire end-to-end.

`createActionExecutor` gains an optional `rules?: RuleDefinition[]`. When provided, the executor runs `collectRules(actionName, rules)` + `evaluateRules` after input validation and before the write, and applies the pre-write decision effects:

- **block** → aborts the action with the block reason(s); the handler and write never run.
- **enrich** → merges `setFields` into the input that reaches the handler / write path.
- **warn** → surfaces messages on `ActionResult.warnings`; the action still succeeds.

Only rules whose `trigger.action` targets the running action fire; `skipRules` (approved re-execution) is honored. Conditions are evaluated against the validated input — record-state conditions (reading the pre-existing record) and the post-commit effects (`require_approval`, `execute_action`, `trigger_flow`) land in follow-up phases.

The capability-aggregated rule set is now injected at every production executor construction site (adapter-server `createRuntimeContext`, CLI `dev` and `exec`). Non-breaking: when `rules` is omitted (tests, minimal setups) behavior is unchanged.
