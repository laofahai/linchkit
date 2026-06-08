---
"@linchkit/core": minor
"@linchkit/cap-adapter-server": patch
---

Surface the evolution pipeline's per-proposal pre-analysis to human reviewers
(Spec 55 §7.3).

The evolution cycle generates a pre-analysis envelope (dedup / conflict / impact
/ backtest) for every proposal it surfaces (`EvolutionCycleResult.proposalAnalyses`),
but it was DROPPED when those proposals were persisted as governance drafts — so
the reviewer never saw the "why" (evidence / estimated impact / backtest delta /
rationale) behind an AI-surfaced change. This change closes that seam, additively:

- `ProposalDefinition` gains an OPTIONAL `analysis?: ProposalPreAnalysisResult`
  field carrying the read-only pre-analysis. Reuses the existing
  `ProposalPreAnalysisResult` type — no parallel shape.
- `CreateProposalOptions` gains a matching OPTIONAL `analysis` that
  `ProposalEngine.createProposal` stores verbatim onto the draft.
- `persistCycleProposalsAsDrafts` accepts the cycle's `proposalAnalyses` and
  attaches each envelope to its draft, keyed by `proposalId` (the source cycle
  proposal's id). Omitted when absent or unmatched — never fabricated.
- The on-demand `POST /api/evolution/run-cycle` route and the evolution cadence
  wiring forward `proposalAnalyses` so the metadata is attached live.
- The proposal read endpoints (`GET /api/proposals`, `GET /api/proposals/:id`)
  serialize the new `analysis` field for the review UI.

Strictly additive and read-only: this metadata never affects dedup, validation,
approval, or graduation. Drafts still land in `draft` status and the human
approval gate is unchanged — only strengthened by giving the reviewer the
evidence behind the proposal.
