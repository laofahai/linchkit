---
"@linchkit/core": patch
---

Fail closed when a record-state guard rule can't read its row. Previously, when
the record read inside action rule evaluation threw (transient / infra /
partial-access error), evaluation silently degraded to input-only — which let a
record-state `block` / `require_approval` rule be bypassed and the write proceed.

Now a thrown read aborts the action when the applicable rule set contains a
`block` or `require_approval` gate (the action fails with a clear
"could not read … to evaluate guard rules" error). A read that *returns* a falsy
record (the row is genuinely absent — e.g. create-shaped input) is unchanged and
still evaluates input-only; rule sets with only non-gate effects
(`enrich` / `warn` / `execute_action` / `trigger_flow`) also keep the lenient
input-only degrade. This is the first half of issue #462 Part 1; the
in-transaction record-state evaluation (TOCTOU) hardening is tracked separately.
