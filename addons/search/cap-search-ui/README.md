# @linchkit/cap-search-ui

Global Search widget for LinchKit. Provides a controlled text input,
a debounced search panel, and an admin page (`/admin/search`) backed
by the `search` GraphQL query exposed by `@linchkit/cap-search`.

Read-only — the panel issues GraphQL queries via `@linchkit/cap-adapter-ui`'s
default transport (or an injected `transport` via `useSearchClient`). It
never writes data and never bypasses the server-side tenant scope.

## Installation

```bash
bun add @linchkit/cap-search-ui
```

The capability `autoInstall: true` activates whenever `cap-search` and
`cap-adapter-ui` are present in the host bundle.

## Usage

### Drop-in admin page

`cap-search-ui` auto-registers `/admin/search` via the route registry.
Hosting apps that build on `cap-adapter-ui` get the route for free.

### Embedding the panel

```tsx
import { SearchPanel, useSearchClient } from "@linchkit/cap-search-ui";

export function CommandPalette() {
  // Default transport uses cap-adapter-ui's authenticated graphql() client.
  // Pass `{ transport }` to inject a custom GraphQL transport (e.g. in tests).
  const client = useSearchClient();
  return <SearchPanel search={client.search} onSelect={(hit) => navigate(hit)} />;
}
```

### Just the input

```tsx
import { GlobalSearchInput } from "@linchkit/cap-search-ui";

<GlobalSearchInput value={query} onSearch={setQuery} />;
```

## Keyboard

- `⌘K` / `Ctrl+K` — focus the input.
- `Esc` — clear the input and emit an empty query.
