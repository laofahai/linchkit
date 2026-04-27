---
"@linchkit/core": minor
---

Persist `ctx.meta` across approval suspend/resume (Spec 65 §14 M6). Approval-gated actions now carry their original ExecutionMeta through the suspend boundary so handlers see the same `source_view` / `triggered_by` / `bulk` context on the approved rerun as on the original submission. New `ApprovalRequest.meta` field; new `_linchkit.approvals.meta` jsonb column; `createApprovalEngine()` accepts `configRegistry` for resolving `system:execution.meta.maskedKeys`. Meta is sanitized at persist (`_`-prefixed system keys stripped per §4.4; configured masked keys redacted to `***` per §10.3) so the approvals table never holds unredacted secrets and stale `_execution_id` / `_channel` cannot leak into CommandLayer middleware on replay.
