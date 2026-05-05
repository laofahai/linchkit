---
"@linchkit/cap-adapter-server": minor
---

feat(adapter-server): GraphQL `batch_actions` mutation (closes #212)

Adds a code-first `Mutation.batch_actions(actions: [BatchActionInputItem!]!, strategy: String, meta: String): BatchActionsResult!` that mirrors the REST `/api/actions/batch` contract. Per-item input is JSON-string-encoded for parity with the existing `executeAction` mutation (graphql-js code-first ships no JSON scalar), and `BatchActionsResult` exposes `success` / `parentExecutionId` / `strategy` / `succeeded` / `failed` / `rolledBack` / `summary`. Resolved through the same actor / tenant / locale path single-action mutations use; raw-executor fallback intentionally rejected so the permission slot is never bypassed. Optional `transactionManager` on `BuildGraphQLSchemaOptions` lets callers override the CommandLayer default for `executeBatch`.
