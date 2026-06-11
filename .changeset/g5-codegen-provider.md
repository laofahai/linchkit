---
"@linchkit/core": minor
"@linchkit/cap-ai-provider": minor
---

G5 Phase 1 — implement the `CodeGenerationProvider` seam.

`@linchkit/core` previously declared a `CodeGenerationProvider` interface
("implemented by cap-ai-provider") but no implementation existed and the type was
not exported from any public barrel. This adds:

- `@linchkit/core/server` now exports the `CodeGenerationProvider`,
  `CodeGenerationResult`, `ProjectContext`, and `QualityGateRunner` types so a
  capability can implement the seam.
- `@linchkit/cap-ai-provider` exports `createCodeGenerationProvider(ai, options)`
  — a thin adapter over the configured `AIService` (GLM/zhipu/etc. per
  `linchkit.config`) that turns a prompt (+ optional context) into generated
  TypeScript source.

This is the foundation for AI code generation of the irreducibly-code parts of a
proposal (action / event-handler / flow logic bodies). It only PRODUCES candidate
source as a string — it never writes files, runs code, or touches the approval /
graduation path. Generated source still flows through validation and double human
review (draft + graduation PR) before it can land.
