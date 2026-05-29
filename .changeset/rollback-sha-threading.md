---
"@linchkit/core": minor
---

Thread the merged commit SHA end-to-end through the rollback Insight→Proposal
loop (Spec 55 §7.7), so a rollback executor can `git revert` the exact regressed
commit instead of only naming the proposal.

The SHA originates from `ProposalGitCommitter.commitAndOpenPR` (`commitSha`) and
now flows: outcome payload (`ProposalOutcomePayload.mergedSha`, finally wiring
the previously-orphaned `resolveMergedSha` capture) → effect-verification record
and signal (`EffectVerificationRecord.mergedSha`) → rollback Insight evidence
(`evidence.context.mergedSha`) → the revert `ProposalChange.revertSha` stamped by
`rollbackCandidateTranslator`.

Adds a pure, side-effect-free consumption helper
`rollbackInputFromProposal(proposal)` that maps an APPROVED revert proposal to a
`DeployRollbackOrchestrator` `RollbackInput`. It declines (returns `null`) for
non-approved proposals or a missing SHA and never auto-executes — the rollback
proposal stays `status: "draft"` and only graduates through the human approval
gate.
