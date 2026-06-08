---
"@linchkit/core": minor
"@linchkit/cap-adapter-server": patch
---

Wire the Phase 4 generated-source contract gate to the environment (Spec 55 §7,
Spec 09). The validator (`validatePhase4`) and its `strictGeneratedContract`
gating already existed in core, but the flag was never reachable from the
deployment environment — so production could never actually block a
contract-violating AI-generated `generatedSource`, it only ever warned.

`EnvironmentFeatureFlags` gains `strictGeneratedContract`, derived from
`isProduction` (the same expression as `strictCompatibility`, so the two Phase 3
and Phase 4 gates move in lock-step — production and staging block, development
stays warn-only). The adapter-server now threads
`environment.features.strictGeneratedContract` through `mountProposalAPI` into the
`ValidationContext`, so proposal validation flips Phase 4 findings from
non-blocking warnings to blocking errors in production-like environments. No
behavior change in development.
