# @linchkit/cap-adapter-ui

Frontend UI adapter for LinchKit — React 19 + Shadcn + TanStack Router/Query/Table. Provides entity-driven UI components (AutoForm, AutoList), shell layout, i18n, and theme support.

## Installation

```bash
bun add @linchkit/cap-adapter-ui
```

## Peer Dependencies

- `@linchkit/core` ^0.1.0

## Usage

### Capability Registration

```ts
import { capAdapterUi } from "@linchkit/cap-adapter-ui";
```

### Components

```tsx
import { AutoForm } from "@linchkit/cap-adapter-ui";
import { AutoList } from "@linchkit/cap-adapter-ui";
import { ShellLayout } from "@linchkit/cap-adapter-ui";

// Entity-driven form
<AutoForm entity="order" mode="create" />

// Entity-driven list with search, filters, and toolbar
<AutoList entity="order" />
```

### Hooks and Utilities

```ts
import { useBreadcrumb } from "@linchkit/cap-adapter-ui";
import { useEntityLabel } from "@linchkit/cap-adapter-ui";
import { changeLanguage, supportedLanguages } from "@linchkit/cap-adapter-ui";
```

### Sub-entry Points

| Path | Description |
|------|-------------|
| `@linchkit/cap-adapter-ui` | Main entry — components, hooks, i18n |
| `@linchkit/cap-adapter-ui/panel-registry` | Record detail panel registration |
| `@linchkit/cap-adapter-ui/route-registry` | Admin route registration |
| `@linchkit/cap-adapter-ui/hooks/use-subscription` | SSE subscription hook |
| `@linchkit/cap-adapter-ui/lib/api` | API client utilities |

## Links

- [Repository](https://github.com/laofahai/linchkit)
