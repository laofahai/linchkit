---
"@linchkit/core": minor
---

feat(spec-55): ProposalFileWriter — persist approved Proposals to disk

Closes the human-in-the-loop hand-off in the Spec 55 evolution loop. Once a Proposal reaches `status="approved"`, the new `ProposalFileWriter` writes its changes as TypeScript source files under `addons/<group>/cap-<short>/src/{rules,views,flows,entities,...}/_<proposal-id>.<kind>.ts` so the developer can review the diff in source control and rebuild. The `ProposalEngine` constructor gains an optional `onApproved` callback that consumers can wire to trigger the writer (or any other downstream persistence — Git PR, hot-reload, etc.). Failures in the callback are captured in `proposal.persistenceError` and do not roll back the approval status.

BREAKING CHANGE: `ProposalEngine.approveProposal` is now async (returns `Promise<ProposalDefinition>` instead of `ProposalDefinition`) so the `onApproved` hook can be awaited. Direct callers must add `await`.
