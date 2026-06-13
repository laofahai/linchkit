---
"@linchkit/core": minor
"@linchkit/cap-adapter-server": patch
"@linchkit/cap-adapter-mcp": patch
---

Wire the natural-language "say→change an existing code-condition rule's threshold" path to a structured `sourcePatch` (#566). When an utterance asks to change a constant a code-condition rule owns (e.g. "raise the manager-approval threshold to 20000"), the resolver now emits a `newValueLiteral` — gated by a strict `isSafeValueLiteral` validator (number / boolean / null / JSON string only, no expressions) — and `draftRuleUpdate` assembles a `ProposalDiff.sourcePatch { filePath, constantName, newValueLiteral }` when the rule opts in via the new `RuleDefinition.patchTarget`. The adapter-server route copies this onto the governed `ProposalChange.sourcePatch` consumed by `ProposalFileWriter`, and both adapter-server and adapter-mcp project `patchTarget` into the AI-facing rule snapshot.

New public API: `isSafeValueLiteral`, `RuleDefinition.patchTarget`, `SchemaIntentRule.patchTarget`, `ProposalDiff.sourcePatch`, `ParsedSchemaIntent.newValueLiteral`.
