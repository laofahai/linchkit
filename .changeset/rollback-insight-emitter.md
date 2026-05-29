---
"@linchkit/core": minor
---

feat(spec-55): RollbackInsightEmitter — surface rollback Insights from failed proposal effects (§7.7 Phase 2 downstream)

Adds RollbackInsightEmitter — reads `proposal:effect:failed` signals emitted by ProposalEffectVerifier and surfaces one evidence-backed rollback `Insight` (tagged `"rollback_candidate"`) per failed proposal whose payload carries `rollback_candidate: true`. Emission is idempotent via a deterministic id (`rollback-insight:<proposalId>`), supports an optional `since` filter, and exposes a `getInsights()` accessor mirroring InsightEngine. Stays in scope: emits the Insight only — never auto-executes a rollback, invokes DeployRollbackOrchestrator, or creates a Proposal; rollback remains a separate human-approved Proposal. Intentionally NOT auto-wired.
