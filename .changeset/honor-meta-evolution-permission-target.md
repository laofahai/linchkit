---
"@linchkit/cap-permission": patch
---

Permission middleware now honours the documented `meta.evolution` permission
target. A non-action dispatch (`skipActionSlots`, e.g. the evolution run-cycle
route) publishes its authoritative target in `ctx.meta.evolution = { operation }`
— a contract `command-layer.ts` documents — but the middleware previously
ignored it and gated on the synthetic command name, so a natural grant could
never authorize it (silent default-deny / admin-only). The middleware now
resolves `meta.evolution.operation` to the `evolution`/`<operation>` target, so a
group granting `grant.evolution.actions.run_cycle` authorizes the cycle as
intended. Scoped to non-action dispatches (`ctx.action` absent) — a real action's
authorization target is never affected.
