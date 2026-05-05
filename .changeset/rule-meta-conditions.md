---
"@linchkit/core": minor
---

feat(core): rule conditions resolve `meta.*` field paths against `ExecutionMeta` (Spec 65 §6)

`RuleEvalInput` gains an optional `meta?: ExecutionMeta` field, threaded into
the per-rule `ConditionContext`. Field paths in rule conditions that begin with
`meta.` now resolve against `ctx.meta?.get(...)` instead of the entity record,
with one level of dotted nesting after the meta key (`meta.source.channel`).
Missing keys return `undefined` — same shape as missing entity fields, so
existing rules without `meta.*` references keep working unchanged.
