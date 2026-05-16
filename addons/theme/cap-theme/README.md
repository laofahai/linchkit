# @linchkit/cap-theme

System / light / dark mode toggle for LinchKit. Ships a `<ThemeProvider>`, a
`useTheme()` hook and a ready-to-use `<ThemeToggle>` button that cycles through
the three preferences. Selection persists to `localStorage` and `"system"`
mode tracks the OS `prefers-color-scheme` setting in real time.

## Installation

```bash
bun add @linchkit/cap-theme
```

The capability is `autoInstall: false` while it coexists with the legacy
`useTheme` helper in `@linchkit/cap-adapter-ui`. Activate it explicitly from
your host bundle.

## Peer dependencies

- `@linchkit/core` ^0.2.0
- `@linchkit/cap-adapter-ui` ^1.0.0
- `react` ^19.0.0
- `react-i18next` >=14.0.0

## Setup

Wrap the app once, near the root, so every consumer sees the same context:

```tsx
import { ThemeProvider } from "@linchkit/cap-theme";

export function Root({ children }: { children: React.ReactNode }) {
  return <ThemeProvider defaultMode="system">{children}</ThemeProvider>;
}
```

Drop the toggle anywhere inside the provider:

```tsx
import { ThemeToggle } from "@linchkit/cap-theme";

export function Header() {
  return <ThemeToggle className="rounded-md p-2 hover:bg-muted" />;
}
```

Or read the state directly:

```tsx
import { useTheme } from "@linchkit/cap-theme";

const { mode, resolvedMode, setMode } = useTheme();
```

## Tailwind dark-mode requirement

Tailwind must be configured with the `class` (or v4 `&:is(.dark *)` custom
variant) strategy so the toggle's `documentElement.classList.toggle("dark", …)`
call activates the `dark:` utilities. `@linchkit/cap-adapter-ui` already
configures this in its shipped stylesheet — host apps that bring their own
Tailwind setup need to mirror it.

## localStorage key

The user preference is persisted under `linchkit:theme` as a JSON-encoded
string. Importing `THEME_STORAGE_KEY` from the package keeps consumers in sync
if they need to clear the key out-of-band.

## Related

- Issue #121 — System / light / dark mode toggle
- Spec 14 — System Capabilities
