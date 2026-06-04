---
"@linchkit/cap-adapter-server": minor
---

Wire an in-process `SyncFlowEngine` into the `createDevApp` / `createRuntimeContext` boot path so a `trigger_flow` rule effect actually starts its flow. Previously this DB-free, in-process path never aggregated capability flows nor built a flow engine, so the effect silently logged + skipped. `createRuntimeContext` now accepts `flows` and builds a default sync engine from them; `assembleDevSchema` / `extractCapabilities` aggregate `cap.flows`. An externally injected `flowEngine` (e.g. the durable Restate engine wired by `linch dev`) still takes precedence and is unaffected. (#476)
