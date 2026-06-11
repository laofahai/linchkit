---
"@linchkit/cap-adapter-ui": minor
---

Add a human-gated Proposal Review page (`/admin/proposals`) that lists governed
proposals and lets a reviewer approve / reject pending ones and **graduate** an
approved one (write its definition files and open a GitHub PR). Also add a "Run
Evolution Cycle" trigger on the Evolution page that runs one on-demand cycle and
reports how many draft proposals it created.

Together these complete the end-to-end UI for the evolution governance loop:
trigger a cycle → review the resulting drafts → approve → graduate to a PR. Every
mutation is an explicit user click; graduation only ever opens a PR for review —
the UI never auto-approves, auto-graduates, or merges anything.
