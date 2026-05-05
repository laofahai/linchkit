---
"@linchkit/core": minor
"@linchkit/cap-adapter-mcp": minor
---

feat: MCP adapter auto-injects `_mcp_client_id` into ExecutionMeta (Spec 65 §3.3)

The MCP adapter now stamps the authenticated client's registration ID into
`ctx.meta._mcp_client_id` at action dispatch, so handlers, rules, and
EventHandlers can attribute MCP-originating calls to a specific client. Core
gains a `systemMeta?: Record<string, unknown>` option on `CommandExecuteOptions`
/ `ExecuteOptions` to allow trusted adapters to seed `_`-prefixed system keys
(framework reserved keys `_channel` / `_execution_id` / `_depth` /
`_source_action` are protected; non-`_` keys are silently dropped). When no
authenticated client is present (stdio / open-access / simple-bearer-token),
no fake ID is invented — the field is omitted.
