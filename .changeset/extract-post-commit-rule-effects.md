---
"@linchkit/core": patch
---

refactor(core): extract the post-commit rule side-effect runner
(`execute_action` / `trigger_flow`) out of `createActionExecutor` into a new
`engine/action-rule-effects.ts` (`runPostCommitRuleEffects`). It pairs with
`action-rule-eval.ts` (decide) as the run-the-collected-effects half, and is
the lowest-coupling slice of the executor body (best-effort, fires only after
the write is durable). Pure code movement — zero behavior change (part of #462).
