---
"@linchkit/core": minor
"@linchkit/cap-adapter-server": minor
---

feat: graduate an NL-drafted relation as a first-class change (#580)

`relation` is now a first-class graduable `ProposalChange`: added to `ProposalChangeTarget` and the `ChangeDefinition` union, wired into `ProposalFileWriter` (relations/ subdir, `defineRelation` factory), and classified additive/non-breaking by the impact analyzer. An `add_entity`-with-relation proposal now persists a SECOND `relation` change (the entity change stays a clean `EntityDefinition`) and graduates to BOTH `defineEntity()` and `defineRelation()` source.
