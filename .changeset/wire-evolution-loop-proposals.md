---
"@linchkit/cli": minor
---

Wire the Spec-55 evolution loop's dormant proposal generation into the live `linch dev` boot path. The dev runtime now passes `ontology`, `translatorRegistry`, `proposalCapability`, and a dedup+impact pre-analysis pipeline to `createEvolutionRuntime()`, so surfaced insights are translated into analyzed proposals instead of dead-ending at the Insight stage. Proposals appear strictly as data on the cycle result — no graduation (file write / git commit) is wired.
