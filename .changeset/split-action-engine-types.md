---
"@linchkit/core": patch
---

refactor(core): split the action-engine public type surface and stateless
helpers out of `action-engine.ts`. The contract types (`DataProvider`,
`ActionExecutor`, `ExecuteOptions`, `ActionExecutorOptions`, …) now live in
`engine/action-engine-types.ts`, and the module-private helpers
(`isExecutionMeta`, `fillMissingSystemKeys`, `checkAndRunFieldLockInterceptor`)
moved into the existing `engine/action-helpers.ts`. `action-engine.ts`
re-exports every type for backward compatibility, so all existing
`from "@linchkit/core"` / `from "./action-engine"` imports keep working
unchanged. Pure code movement — zero behavior change (part of #462).
