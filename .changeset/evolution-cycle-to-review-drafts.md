---
"@linchkit/core": minor
"@linchkit/cap-adapter-server": minor
---

Bridge the Spec-55 evolution cycle into the governance review pipeline (on-demand). The evolution `runCycle()` was never invoked at runtime and its proposals were transient — they never reached human review. New `persistCycleProposalsAsDrafts` helper (`@linchkit/core`) maps each cycle `ProposalDefinition` to a governance `draft` via `ProposalEngine.createProposal`, deduped against the already-pending set (capability + change names) so re-running a cycle is idempotent. New `POST /api/evolution/run-cycle` endpoint (`@linchkit/cap-adapter-server`) runs one cycle on demand through CommandLayer (permission slot never skipped; 501 when the evolution runtime is absent, 503 when the command layer is absent) and persists the results as drafts, returning `{ created, deduped, total, createdIds }`.

Strictly drafts-only: nothing is submitted, validated, approved, committed, deployed, or graduated, and there is no scheduler — invocation cadence and graduation (to files/PR) remain deferred. Pre-analysis envelopes are not attached (no slot on the proposal shape; out of scope).
