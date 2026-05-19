# @linchkit/cli

## 0.3.0

### Minor Changes

- a41b02f: feat(cli): `linch exec` runs a named Action with input + ExecutionMeta (Spec 65 §3.5)

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

### Patch Changes

- Updated dependencies [74ea5ba]
- Updated dependencies [a41b02f]
- Updated dependencies [64ad4c0]
- Updated dependencies [4c19796]
- Updated dependencies [4b4f259]
- Updated dependencies [587f2c9]
- Updated dependencies [5108a65]
  - @linchkit/core@0.3.0
  - @linchkit/cap-flow-restate@2.0.0
  - @linchkit/cap-migration@2.0.0
  - @linchkit/devtools@0.3.0

## 0.2.0

### Minor Changes

- b117c2c: Initial public release — M3 milestone

  - Runtime Entity Overlay (Spec 59): JSONB \_extensions, overlay registry, GraphQL hot-reload
  - AI Workspace (Spec 60): linch doctor, linch info, linch agents-md, linch mcp-dev
  - Core i18n: capability-owned translations, resolveLabel for CLI/MCP
  - Publishing infrastructure: tsup builds, OCA source addons, changesets

### Patch Changes

- Updated dependencies [b117c2c]
  - @linchkit/core@0.2.0
  - @linchkit/devtools@0.2.0
  - @linchkit/cap-flow-restate@1.0.0
  - @linchkit/cap-migration@1.0.0
