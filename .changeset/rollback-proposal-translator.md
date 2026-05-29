---
"@linchkit/core": minor
---

Add the rollback Insight→Proposal translator (Spec 55 §7.7 Phase 2, Slice A).

A `rollback_candidate`-tagged anomaly Insight (emitted by `RollbackInsightEmitter`
when a merged Proposal fails its successMetric) is now translated into a
governance-safe `status:"draft"` rollback `ProposalDefinition`. The draft carries
a single `target:"revert"` change (with a fixed, validation-safe name `"revert"`)
and an inverse `successMetric`, then flows through the existing Insight→Proposal
pipeline to the HUMAN approval gate. The translator only produces a draft — it
never invokes `DeployRollbackOrchestrator`, performs Git operations, or
auto-executes a rollback.

Supporting changes:
- `ProposalChangeTarget` gains a `"revert"` member.
- Phase-1 validation (`validatePhase1` / `validateProposal`) now skips the
  `MISSING_DEFINITION` requirement for `target:"revert"` changes (mirroring the
  existing `delete` skip), so a definition-less rollback draft passes validation
  and can reach the approval gate. The revert change name is a fixed
  `NAME_PATTERN`-valid identifier; the proposalId being reverted is carried in the
  change `diff` and the proposal's evidence sidecar (`evidence.context.revertProposalId`).
- `ProposalFileWriter` skips `target:"revert"` changes (no source file to write)
  with a warning, mirroring how it skips `delete` operations.
- `insightTranslatorKey()` routes tagged anomalies to `anomaly:rollback_candidate`
  without affecting ordinary anomaly insights.
- The rollback evidence sidecar is now nested under `.context` and enumerable,
  matching `schemaNoViewTranslator`, so `ProposalGitCommitter` recovers the source
  insight id for the commit trailer / PR body and the sidecar survives `JSON.stringify`.
