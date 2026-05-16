# @linchkit/cap-audit-ui

Audit log viewer UI for LinchKit. Provides an admin page that lists every
Action execution recorded in `_linchkit.executions`, with filters
(action / actor / status / entity / date range) and a side-drawer
detail view showing the full input, output, execution meta, and state
transition for a single entry.

Read-only — data is sourced through the existing `executionLogList`
GraphQL query exposed by `@linchkit/cap-adapter-server` against the
`execution_log` system entity. This package never writes audit data
and never queries the `_linchkit.executions` table directly.

## Installation

```bash
bun add @linchkit/cap-audit-ui
```

The capability `autoInstall: true` activates whenever
`@linchkit/cap-adapter-ui` is present.

## Peer dependencies

- `@linchkit/core` ^0.2.0
- `@linchkit/cap-adapter-ui` ^1.0.0
- `react` ^19.0.0
- `react-i18next` >=14.0.0

## Route

Mounted at `/admin/audit` (id: `audit`, order: 110).

## Related

- Spec 11 — Execution Log
- Spec 14 — System Capabilities
- Issue #138
