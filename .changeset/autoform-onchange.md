---
"@linchkit/cap-adapter-ui": minor
---

feat(adapter-ui): AutoForm calls the server-side onchange endpoint and applies returned field updates (Spec 64 M6, closes #207)

User-initiated field changes now POST to `/api/entities/:entity/onchange` (with
configurable debounce, default 300 ms per Spec 64 §6.1), and applied field
updates / warnings come back through the form state. Programmatic writes via
`registerSetField` skip the call (Spec 64 §10). Stale-response protection
uses a monotonic seq + `AbortController` so out-of-order responses don't
overwrite newer state. Network / 4xx / 5xx errors are logged and never block
form submission — onchange is best-effort.

New exports: `useEntityOnchange` hook, `OnchangeDispatcher` /
`buildOnchangeIndex` / `OnchangeFetcher` framework-agnostic primitives,
`requestEntityOnchange` API helper, and the `DEFAULT_ONCHANGE_DEBOUNCE_MS`
constant. AutoForm gains additive props: `onchangeDebounceMs`,
`onchangeFetcher`, `onOnchangeWarnings` — public AutoForm API is unchanged
for callers that don't opt in.
