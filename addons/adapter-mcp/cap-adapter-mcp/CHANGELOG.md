# @linchkit/cap-adapter-mcp

## 2.0.0

### Minor Changes

- 587f2c9: feat: MCP adapter auto-injects `_mcp_client_id` into ExecutionMeta (Spec 65 §3.3)

  The MCP adapter now stamps the authenticated client's registration ID into
  `ctx.meta._mcp_client_id` at action dispatch, so handlers, rules, and
  EventHandlers can attribute MCP-originating calls to a specific client. Core
  gains a `systemMeta?: Record<string, unknown>` option on `CommandExecuteOptions`
  / `ExecuteOptions` to allow trusted adapters to seed `_`-prefixed system keys
  (framework reserved keys `_channel` / `_execution_id` / `_depth` /
  `_source_action` are protected; non-`_` keys are silently dropped). When no
  authenticated client is present (stdio / open-access / simple-bearer-token),
  no fake ID is invented — the field is omitted.

### Patch Changes

- Updated dependencies [74ea5ba]
- Updated dependencies [a41b02f]
- Updated dependencies [64ad4c0]
- Updated dependencies [4c19796]
- Updated dependencies [4b4f259]
- Updated dependencies [587f2c9]
- Updated dependencies [5108a65]
  - @linchkit/core@0.3.0

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
