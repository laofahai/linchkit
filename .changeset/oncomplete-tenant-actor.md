---
"@linchkit/core": patch
---

Propagate tenant and actor through `onComplete` flow chains (tenant-isolation fix).

`processOnCompleteChains` started each downstream chained flow with `{ tenantId: undefined }` and no actor (the "inherit from context if available" comment was never implemented), so an `onComplete`-chained flow ran with no tenant scope and the default system actor — able to read/write records outside the originating tenant. `FlowInstance` now persists the run's `tenantId` and `actor` (both optional, backward-compatible), and `processOnCompleteChains` forwards them to the chained `startFlow`, mirroring the post-commit rule-effect path. No function signature change.
