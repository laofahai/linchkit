---
"@linchkit/core": minor
---

G5 Phase 2 + 3 — proposal code materialization + build-gate (engine).

- **Materializer (P3):** `materializeProposalChanges({ proposal, provider, qualityGate?, maxRetries?, context? })` generates TypeScript source for the irreducibly-code parts of a proposal (action / event / flow logic bodies) via a `CodeGenerationProvider`, attaching it to each change as the new optional `ProposalChange.generatedSource`. Declarative targets (entity / rule / view / state / overlay) and deletes are skipped. Generate → quality-gate → retry-with-feedback (default 3 attempts). Returns a COPY — never mutates the input, never writes files, runs code, approves, or graduates.
- **Build gate (P2):** `checkSourceSyntax()` / `createSyntaxQualityGate()` validate generated source SYNTACTICALLY via Bun's transpiler (no project-aware type resolution — that would false-positive on project symbol references; left to the graduation PR's CI). `validatePhase2()` runs this over a proposal's `generatedSource` and is now wired into `validateProposal` (previously a skipped stub). Warn-only by default; `ValidationContext.strictGeneratedBuild` escalates to blocking. All-declarative proposals still see Phase 2 "skipped" — existing callers are unaffected.
- New `@linchkit/core/server` exports: `materializeProposalChanges`, `isMaterializable`, `validatePhase2`, `checkSourceSyntax`, `createSyntaxQualityGate` (+ types).

SAFETY: candidate source only — it flows through validation (Phase 2) and double human review (draft + graduation PR) before it can land. "AI never modifies production directly." Not yet wired into a live HTTP/draft path (a thin follow-up).
