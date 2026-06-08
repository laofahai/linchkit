---
"@linchkit/core": minor
---

Tenant-scope evolution sensor reads (Spec 55 §7, #500). Both the on-demand
`POST /api/evolution/run-cycle` endpoint and the opt-in cadence pass a `tenantId`
into the cycle's `SensorContext`, but the runtime query path ignored it — so a
per-tenant cycle could observe global / cross-tenant data.

`createDispatchQuery` now accepts an optional `tenantId` and applies it through
the canonical, provider-enforced isolation mechanism: business reads pass it as
`DataQueryOptions.tenantId` (Drizzle adds `WHERE tenant_id = …` only for tables
that have a tenant column, and no-ops otherwise; InMemoryStore filters likewise)
and `execution_log` reads pass it as `findMany({ tenantId })`.

`createEvolutionRuntime` gains an optional `queryFactory(tenantId?)` that builds a
fresh, tenant-scoped query for each `runCycle` (consulted lazily — a caller's own
`ctx.query` still wins). The dev wiring switches to this factory, so per-tenant
on-demand and cadence cycles read only their own tenant's data. The static
`query` option remains for backward compatibility; single-tenant / dev runs (no
`tenantId`) are unscoped exactly as before. A set-but-blank `tenantId` is
rejected at construction (the backends only scope on a truthy value, so a blank
would silently read globally) — pass `undefined` to run intentionally unscoped.
