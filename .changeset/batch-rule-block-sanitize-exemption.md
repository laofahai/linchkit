---
"@linchkit/core": patch
"@linchkit/cap-adapter-server": patch
---

fix(core,adapter-server): rule_block policy text survives batch production sanitization

`extractErrorFromResult` in the batch action engine now threads the engine-stamped `data.context.constraint` marker (e.g. `"rule_block"`) onto `BatchFailedItem.error.constraint` (additive, optional) — including through the `all_or_nothing` abort path. `sanitizeBatchResult` (shared by REST `POST /api/actions/batch` and GraphQL `Mutation.batch_actions`) uses that server-controlled marker to keep a rule `block` reason — the rule author's user-facing policy text — verbatim in production, mirroring the single-action route's exemption. All other failures are still flattened to the generic message.
