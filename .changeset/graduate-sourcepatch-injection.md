---
"@linchkit/cap-adapter-server": patch
---

Make "say→change an existing code-condition rule's threshold" graduate to REAL source (#566 capstone). The proposal graduate API gains an injectable `sourcePatcher` option, and the server composition root wires in `patchNamedConstant` from `@linchkit/devtools` (the TS-AST patcher behind core's typescript-free `SourcePatcher` seam). An approved rule-update proposal carrying a `sourcePatch` now rewrites the named constant in the actual source file during graduation, then opens the usual human-reviewed PR — closing the natural-language → real-code arm across every channel. Adds `@linchkit/devtools` as a dependency.
