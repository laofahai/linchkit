---
"@linchkit/cap-adapter-server": minor
"@linchkit/cli": patch
---

Wire an in-process `SyncFlowEngine` into the `createDevApp` / `createRuntimeContext` boot path so a `trigger_flow` rule effect actually starts its flow. Previously this DB-free, in-process path never aggregated capability flows nor built a flow engine, so the effect silently logged + skipped. `createRuntimeContext` now accepts `flows` and builds a default sync engine from them; `assembleDevSchema` / `extractCapabilities` aggregate `cap.flows`. An externally injected `flowEngine` (e.g. the durable Restate engine wired by `linch dev`) still takes precedence and is unaffected.

Also forward the Saga compensation idempotency key (Spec 26 §3.2) from the flow step context into `executor.execute` in both flow-engine wiring sites (`createRuntimeContext` and `dev-wiring.ts`), so a retried compensating action started through the sync flow engine is not executed twice. (#476)
