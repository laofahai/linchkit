---
"@linchkit/cli": minor
"@linchkit/core": patch
---

feat(cli): `linch exec` runs a named Action with input + ExecutionMeta (Spec 65 §3.5)

```
linch exec approve_request --input '{"id":"pr_001"}' --meta '{"bulk":true}'
```

The new `exec` command boots a minimal in-process runtime (config / registries
/ database / auth provider / ActionExecutor + CommandLayer; transports / Restate
flow engine / AI service / sensors / cache manager are skipped — exec is one-
shot) and dispatches the named Action through CommandLayer. `_`-prefixed meta
keys are stripped pre-flight (Spec 65 §4.4) and JSON byte size is checked
against `DEFAULT_META_MAX_BYTES` (8 KB; Spec 65 §10.2). Exit codes: 0 success,
1 user input / validation errors, 2 action failure or bootstrap throw.
Mutually exclusive `--input` / `--input-file` and `--meta` / `--meta-file`.

Core also re-exports `DEFAULT_META_MAX_BYTES`, `MetaSizeError`,
`createExecutionMeta`, `redactMetaForLog` as runtime exports so external
runners (CLI, future scripting hosts) can construct meta safely.
