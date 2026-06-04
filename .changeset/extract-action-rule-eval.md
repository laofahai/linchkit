---
"@linchkit/core": patch
---

Extract the action-execution rule-evaluation decision (Step 4c) out of the
~2k-line `action-engine.ts` into a focused, unit-testable `evaluateActionRules`
helper (`engine/action-rule-eval.ts`). Pure internal refactor — no public API or
runtime behavior change; the executor keeps ownership of execution logging,
approval-request creation, and the early returns. This is the first cut of the
`action-engine.ts` split and sets up the in-transaction record-state evaluation
hardening (issue #462).
