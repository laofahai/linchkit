---
"@linchkit/core": patch
---

Rule conditions can now read the persisted record independently of caller input:
`RuleConditionContext` / `ConditionContext` / `RuleEvalInput` gain an optional
`record` field (the stored row backing `target`, which merges input over it),
and declarative conditions resolve `record.*` field paths. Authority/guard rules
should read trustworthy values from `record` — reading `target` is bypassable by
input spoofing (e.g. approving a high-value record by sending `{ id, amount: 1 }`).
