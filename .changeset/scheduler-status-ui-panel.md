---
"@linchkit/cap-adapter-ui": minor
---

Add a read-only **scheduler status panel** to the Evolution admin page (Spec 55
§7) so an operator can see the autonomous cadence loop's heartbeat at a glance.

The panel polls `GET /api/evolution/scheduler-status` (the sibling backend PR) and
renders a status pill — Running / Idle / Disabled / Unauthorized / Unavailable —
plus the clamped interval (humanized), ticks completed/started, the last tick time
and duration, and an amber error-streak row (`lastError` + consecutive count) when
the cadence is stuck failing. It auto-polls on a configurable interval with an
`AbortController` that cancels the in-flight request on unmount, and offers a
manual refresh. It is strictly read-only — it never triggers a mutation.

The client (`lib/evolution-api.ts`) mirrors the wire contract locally (the UI never
imports the server/core runtime) and returns a discriminated result so each
outcome (configured / unconfigured / denied / error) is rendered distinctly
instead of thrown. Pure data-shaping helpers (ms humanizer, response→view
reducer, timestamp formatter) are unit-tested without a DOM.
