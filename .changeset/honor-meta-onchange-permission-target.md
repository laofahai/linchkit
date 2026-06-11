---
"@linchkit/cap-permission": patch
---

Permission middleware now honours the documented `meta.onchange` permission
target — the second half of the meta-target contract `command-layer.ts` documents
(the `meta.evolution` half was wired in the prior patch). The onchange route
(`POST /api/entities/:name/onchange`, Spec 64) dispatches with `skipActionSlots`
and no `ctx.action`, publishing its target in `ctx.meta.onchange = { entity }`. The
middleware now resolves this to an entity-level **READ** check: the actor may run
the onchange computation iff `grant.<entity>.data.read` resolves to anything other
than `none` (explicit `none` still wins). Previously the dispatch was gated on the
synthetic command name `"<entity>.onchange"`, which no group grants → silent
default-deny / admin-only. Scoped to non-action dispatches (`ctx.action` absent),
so a real action's authorization target is never affected.
