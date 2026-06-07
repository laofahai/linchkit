---
"@linchkit/core": minor
"@linchkit/cap-adapter-server": minor
---

Implement proposal-validation Phase 3 (compatibility / breaking-reference checks, Spec 09 §4.5). `validatePhase3` inspects a proposal's delete/narrowing changes against the current meta-model (via the OntologyRegistry impact graph + field-reference scan) and flags breaking references: deleting a field still referenced by a view/rule, deleting an action/state with dependents, changing a field type, dropping a required field's default, or removing an enum value.

Warn-only by default (does not affect `passed`); escalates to blocking errors when `strictCompatibility` is set. A new `features.strictCompatibility` env flag (default: true in production and staging, false in dev/test, mirroring `strictValidation`) wires this through `mountProposalAPI` so production and staging refuse proposals that break existing references while dev/test stays advisory. `ValidationContext` gains optional `ontology` + `strictCompatibility` fields; when absent, Phase 3 degrades to "skipped" so existing callers are unchanged.
