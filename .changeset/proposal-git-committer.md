---
"@linchkit/core": minor
---

feat(spec-55): ProposalGitCommitter — graduate approved Proposals to a GitHub PR

Adds ProposalGitCommitter capability — graduates approved Proposals from on-disk files (via ProposalFileWriter) to a GitHub PR. The committer is a thin orchestrator: it derives a branch name from the proposal, creates the branch off the configured base, stages exactly the files written by ProposalFileWriter, commits with a structured message carrying `Proposal-ID` / `Source-Insights` trailers, pushes to the remote, and opens a PR via `gh`. Composes with `ProposalEngine.onApproved` hook — wiring is left to the caller so projects can stage or batch PRs. Subprocess runners are injectable for tests; the default implementation uses `Bun.spawn`. No breaking change.
