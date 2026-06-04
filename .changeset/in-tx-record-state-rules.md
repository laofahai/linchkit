---
"@linchkit/core": minor
---

fix(core): evaluate record-state guard rules inside the write transaction
(#462 / #466 TOCTOU hardening).

For a top-level transactional action, a record-state `block` / `require_approval`
rule is now re-evaluated against the transactional snapshot inside `runHandler`,
immediately before the write — the same snapshot the write commits to. This
closes the integrity-critical TOCTOU window: a concurrent commit landing between
the pre-write rule read and the write can no longer let a now-blocked /
now-approval-required action write through. The pre-write Step 4c pass is
retained (it derives `enrich` / `warn` / post-commit side effects and provides
an early rejection); the in-transaction re-check is the authoritative guard.

Mirrors the in-transaction relocation field-lock enforcement took in #203.
Nested actions (already reading the parent transaction) and non-transactional
actions are unchanged. The reverse direction — a guard that fired on a
now-stale pre-write snapshot but would not on the fresh one — still early-rejects
pre-write; that is a retryable false-rejection, not a write-integrity violation,
consistent with field-lock's pre-transaction preflight.

Scope: this collapses the wide pre-write window (Step 4c ran before validation,
the state-machine check, and handler setup) by moving the guard read inside the
transaction adjacent to the write. It does not, by itself, make read+write
atomic under PostgreSQL READ COMMITTED — full closure needs row-level locking
(`SELECT … FOR UPDATE`) or a snapshot-stable isolation level, neither of which
the DataProvider interface exposes today (tracked as #466 follow-up). The same
residual applies to field-lock #203. Fully closed for the InMemoryStore and
under serializable isolation.
