---
"@linchkit/cap-adapter-ui": patch
---

Render the per-proposal pre-analysis (Spec 55 §7.3) on the human review page
(`/admin/proposals`). The governed proposal now carries an optional `analysis`
field (dedup / conflict / impact / backtest envelopes, surfaced by #504); the
review card wires the existing `ProposalImpactPreview` component to it, shown as
decision-support evidence above the approve/reject controls. Absent for manual
drafts. Read-only — no change to the human-gated approve/graduate flow.
