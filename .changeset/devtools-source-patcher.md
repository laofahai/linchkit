---
"@linchkit/devtools": minor
---

Add `patchNamedConstant`, an injectable TS-AST implementation of core's `SourcePatcher` seam (#566). It rewrites a single top-level `export const NAME = <literal>` initializer in an existing source file by splicing the initializer's byte span — comments, type annotations, and the rest of the file are untouched. Throws on NOT FOUND / AMBIGUOUS / NO INITIALIZER and is idempotent (`changed: false`) when the constant already holds the target value. `typescript` is promoted from a dev to a runtime dependency since the patcher ships in the package output.
