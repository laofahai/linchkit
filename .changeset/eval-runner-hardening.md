---
"@linchkit/devtools": patch
"@linchkit/cap-ai-provider": patch
---

Wire pattern-detector `state_flow` fixtures and bring eval-runner adapters into typecheck (#393, #394). `PatternExecLogInput` gains optional top-level `recordId` / `stateTransition` fields the detector reads for state-flow analysis, and the pattern-detector scenario adapter now maps them (plus fixes an invalid `ActorType` cast and a `PatternDetectorConfig` argument mismatch). Root `tsconfig.json` now includes `addons/*/cap-*/eval-runner/**` so `bun run typecheck` validates the scenario adapters going forward.
