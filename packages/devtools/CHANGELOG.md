# @linchkit/devtools

## 0.3.0

### Patch Changes

- 6ba3f7e: Wire pattern-detector `state_flow` fixtures and bring eval-runner adapters into typecheck (#393, #394). `PatternExecLogInput` gains optional top-level `recordId` / `stateTransition` fields the detector reads for state-flow analysis, and the pattern-detector scenario adapter now maps them (plus fixes an invalid `ActorType` cast and a `PatternDetectorConfig` argument mismatch). Root `tsconfig.json` now includes `addons/*/cap-*/eval-runner/**` so `bun run typecheck` validates the scenario adapters going forward.
- Updated dependencies [aa4fe90]
- Updated dependencies [74ea5ba]
- Updated dependencies [f0aa51c]
- Updated dependencies [0357153]
- Updated dependencies [3b59ddd]
- Updated dependencies [a41b02f]
- Updated dependencies [7bc18f3]
- Updated dependencies [833e1ad]
- Updated dependencies [ee51432]
- Updated dependencies [64ad4c0]
- Updated dependencies [738d9e9]
- Updated dependencies [4c19796]
- Updated dependencies [eae84e7]
- Updated dependencies [efdfe74]
- Updated dependencies [30f08e7]
- Updated dependencies [f191193]
- Updated dependencies [51ecca1]
- Updated dependencies [e91e3f2]
- Updated dependencies [745debd]
- Updated dependencies [4b4f259]
- Updated dependencies [ca5417e]
- Updated dependencies [bb2ec5e]
- Updated dependencies [587f2c9]
- Updated dependencies [13696ca]
- Updated dependencies [d844445]
- Updated dependencies [4475a69]
- Updated dependencies [13696ca]
- Updated dependencies [59aea2e]
- Updated dependencies [e969502]
- Updated dependencies [e13e172]
- Updated dependencies [7929b5b]
- Updated dependencies [d817334]
- Updated dependencies [13696ca]
- Updated dependencies [7ab2986]
- Updated dependencies [e4e6a18]
- Updated dependencies [94d6962]
- Updated dependencies [90bd84b]
- Updated dependencies [0802b40]
- Updated dependencies [5108a65]
- Updated dependencies [106e926]
- Updated dependencies [ebac7d6]
- Updated dependencies [d6b250d]
- Updated dependencies [9f00487]
- Updated dependencies [5f9ff43]
- Updated dependencies [5d8d2d5]
- Updated dependencies [e1f16e8]
- Updated dependencies [9626920]
- Updated dependencies [a1f2bba]
- Updated dependencies [685ccc1]
- Updated dependencies [76511f7]
- Updated dependencies [db10790]
  - @linchkit/core@0.3.0

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
