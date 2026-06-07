---
"@linchkit/core": patch
---

Model state-machine dependency edges in the ontology impact graph. `extractDependencyEdges` now emits a `state_transition` edge (state → action) for each `StateDefinition.transitions[].action` and a `state_machine` edge (entity → state) for each entity field of `type: "state"` whose `machine` names a registered state machine. As a result `impactAnalysis` / `dependencyGraph` — and therefore proposal-validation Phase 3 — now detect that deleting an action used as a state transition, or a state machine attached to an entity, is a breaking change. Closes the documented Phase 3 under-reporting limitation.
