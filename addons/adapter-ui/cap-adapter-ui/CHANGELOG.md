# @linchkit/cap-adapter-ui

## 2.0.0

### Minor Changes

- e41cf3e: feat(adapter-ui): AutoForm calls the server-side onchange endpoint and applies returned field updates (Spec 64 M6, closes #207)

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

- 0f00503: Add a human-gated Proposal Review page (`/admin/proposals`) that lists governed
  proposals and lets a reviewer approve / reject pending ones and **graduate** an
  approved one (write its definition files and open a GitHub PR). Also add a "Run
  Evolution Cycle" trigger on the Evolution page that runs one on-demand cycle and
  reports how many draft proposals it created.

  Together these complete the end-to-end UI for the evolution governance loop:
  trigger a cycle → review the resulting drafts → approve → graduate to a PR. Every
  mutation is an explicit user click; graduation only ever opens a PR for review —
  the UI never auto-approves, auto-graduates, or merges anything.

- 812c5e8: Add a natural-language rule-drafting surface ("说 → 有"). A new `resolveSchemaIntent` API client and `NlRuleDrafter` component (mounted on the Evolution page) let users describe a rule in natural language; the server mints a governed draft Proposal that flows into the existing human-gated review pipeline. The surface renders every outcome state (draft / clarification / no_match / unavailable / error) and never submits, approves, or applies.
- ff02462: Surface proposal validation findings in the proposal review UI. A new read-only `ProposalValidationFindings` component renders each non-skipped validation phase's errors (blocking, destructive styling) and warnings (advisory, amber styling) with their code + message, emphasizing Phase 3 (compatibility / breaking-reference checks) — sorted first with a distinct icon — so a reviewer can see when a proposal would break existing references. The inline `validationResult` shape on `Proposal` is extracted into reusable exported types. Defensive against missing/partial validation data; purely presentational (never approves/applies). Pre-analysis (dedup/impact) is not yet plumbed to the client and is out of scope.
- 00523f8: Add a read-only **scheduler status panel** to the Evolution admin page (Spec 55
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

### Patch Changes

- 13696ca: refactor(adapter-ui): split `lib/api.ts` into focused modules under the 500-line cap. Internal restructuring only — the public API client surface is unchanged.
- fdca981: Render the per-proposal pre-analysis (Spec 55 §7.3) on the human review page
  (`/admin/proposals`). The governed proposal now carries an optional `analysis`
  field (dedup / conflict / impact / backtest envelopes, surfaced by #504); the
  review card wires the existing `ProposalImpactPreview` component to it, shown as
  decision-support evidence above the approve/reject controls. Absent for manual
  drafts. Read-only — no change to the human-gated approve/graduate flow.
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
  - @linchkit/ui-kit@0.2.0
