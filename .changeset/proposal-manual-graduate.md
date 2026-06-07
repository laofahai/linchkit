---
"@linchkit/cap-adapter-server": minor
---

Add a manual, admin-triggered graduation path for approved proposals (Spec 55 §7.6/§7.7). New `POST /api/proposals/:id/graduate` writes an already-`approved` proposal's definition files to disk (`ProposalFileWriter`) and opens a GitHub PR (`ProposalGitCommitter.commitAndOpenPR`). It **never auto-fires on approval** (no `onApproved` wiring, no scheduler) and **never auto-merges** — graduation is human-triggered and the resulting PR is human-reviewed, preserving "AI never modifies production directly".

Guards: `404` if the proposal is missing; `422` if it is not `approved` (the guard runs before any side effect); `503` `GRADUATION.NOT_CONFIGURED` (resolved before touching the engine, no existence leak) when git/GitHub is not configured. Config is sourced from the environment (`GITHUB_TOKEN`/`GH_TOKEN` required; optional `PROPOSAL_GRADUATE_ROOT_DIR`/`_BASE_BRANCH`/`_REMOTE`). On success it records the graduation (approved→committed) best-effort and returns `{ prUrl, branch, commitSha, committed }`.
