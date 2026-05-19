# @linchkit/cap-adapter-server

## 2.0.0

### Minor Changes

- 228a3fc: feat(adapter-server): GraphQL `batch_actions` mutation (closes #212)

  Adds a code-first `Mutation.batch_actions(actions: [BatchActionInputItem!]!, strategy: String, meta: String): BatchActionsResult!` that mirrors the REST `/api/actions/batch` contract. Per-item input is JSON-string-encoded for parity with the existing `executeAction` mutation (graphql-js code-first ships no JSON scalar), and `BatchActionsResult` exposes `success` / `parentExecutionId` / `strategy` / `succeeded` / `failed` / `rolledBack` / `summary`. Resolved through the same actor / tenant / locale path single-action mutations use; raw-executor fallback intentionally rejected so the permission slot is never bypassed. Optional `transactionManager` on `BuildGraphQLSchemaOptions` lets callers override the CommandLayer default for `executeBatch`.

### Patch Changes

- Updated dependencies [74ea5ba]
- Updated dependencies [a41b02f]
- Updated dependencies [64ad4c0]
- Updated dependencies [4c19796]
- Updated dependencies [4b4f259]
- Updated dependencies [587f2c9]
- Updated dependencies [5108a65]
  - @linchkit/core@0.3.0
  - @linchkit/cap-ai-provider@2.0.0

## 1.0.0

### Minor Changes

- b117c2c: Initial public release — M3 milestone

  - Runtime Entity Overlay (Spec 59): JSONB \_extensions, overlay registry, GraphQL hot-reload
  - AI Workspace (Spec 60): linch doctor, linch info, linch agents-md, linch mcp-dev
  - Core i18n: capability-owned translations, resolveLabel for CLI/MCP
  - Publishing infrastructure: tsup builds, OCA source addons, changesets

### Patch Changes

- Updated dependencies [b117c2c]
  - @linchkit/core@0.2.0
