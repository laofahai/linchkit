---
"@linchkit/core": minor
---

feat(core): EventHandlerContext exposes the originating action's `meta` (Spec 65 §7)

EventHandlers now receive `ctx.meta: ExecutionMeta` populated from the action that
emitted the event, so handlers can read flags like `skip_notifications` or `dry_run`
and gate side effects accordingly. Meta is delivery-time only — `EventRecord` carries
an optional `meta` field that is intentionally NOT persisted (both DB-side persistence
sites pick fields explicitly). Handlers triggered without an originating action (system
heartbeats, OutboxWorker retries) get an empty `ExecutionMeta` so `ctx.meta.get(...)`
returns `undefined` rather than throwing. Existing handlers that don't reference `meta`
keep working unchanged.
