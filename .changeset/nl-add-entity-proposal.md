---
"@linchkit/core": minor
"@linchkit/cap-adapter-server": minor
---

feat(说→有): NL schema-intent drafts a governed `add_entity` proposal (#575)

The schema-intent resolver now turns an utterance like "增加一个商品管理" into a governed `add_entity` ProposalDraft (instead of `no_match`). A new `schema-intent-entity-builder` validates the entity shape (snake_case name, no system-field collisions, valid field types/constraints, optional relation endpoints) and mints the draft; `POST /api/ai/resolve-schema-intent` persists it into the shared governed engine so it surfaces in the human-gated review pipeline. Works on an empty catalog (first entity), and surfaces requested-but-malformed relations as errors rather than silently dropping them.
