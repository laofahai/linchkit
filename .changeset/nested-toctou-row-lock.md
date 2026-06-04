---
"@linchkit/core": patch
---

Extend in-transaction record-state guard row-locking to nested actions (#473).

PR #472 (#470) closed the record-state guard TOCTOU window for top-level
transactional actions by acquiring a `SELECT … FOR UPDATE` row lock during the
in-transaction guard re-check, gated on `useTransaction && !parentTxProvider`.
Nested transactional actions (running inside a parent transaction) were excluded:
their Step 4c guard read already uses the parent's transactional provider (so the
snapshot is fresh) but it is a plain unlocked `SELECT`, leaving a residual
read→write race under READ COMMITTED.

The re-check gate is now `inTransaction`, so nested transactional actions also
lock-pin their guarded row from the in-transaction re-check until the parent
commits — uniform with top-level (Step 4c = unlocked preflight, in-tx re-check =
authoritative locked decision). No change for non-transactional actions.
