---
"@linchkit/core": minor
---

Add validation Phase 4 — generated-source contract check (G5). `validatePhase4`
statically (execution-free) verifies that AI-materialized `generatedSource`
actually defines the change's declared target/name (right `define*()` call,
references its name, imports `@linchkit/core`). Warn-only by default; gated to
block via `ValidationContext.strictGeneratedContract`. Wired into
`validateProposal` (was a skipped stub); all-declarative proposals stay
"skipped". No generated code is ever executed — an execution-based dry-run
(sandboxed handler run) is intentionally out of scope.
