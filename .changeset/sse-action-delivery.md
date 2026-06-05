---
"@linchkit/core": patch
"@linchkit/cap-adapter-server": patch
---

fix: deliver action-driven SSE events for CRUD writes

CRUD actions emitted `record.created`/`updated`/`deleted` with a `schema` payload
field but no `entity`, so the action-engine event flush set the bus `EventRecord`'s
`entity` to `undefined` and `SubscriptionManager.dispatchEvent` dropped the event —
action-driven create/update/delete never reached SSE subscribers. CRUD actions now
emit the canonical `entity` field (keeping `schema` as a legacy alias), and the
event flush falls back to `payload.schema` when `entity` is absent (#482).
