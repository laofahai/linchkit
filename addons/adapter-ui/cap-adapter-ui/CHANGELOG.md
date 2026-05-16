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
  - @linchkit/ui-kit@0.2.0
