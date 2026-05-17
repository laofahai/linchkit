# @linchkit/cap-keyboard-shortcuts

Global keyboard shortcut registry, `useShortcut` hook, and a `Shift+?`
cheatsheet overlay for LinchKit apps. Refs #121.

## Installation

```bash
bun add @linchkit/cap-keyboard-shortcuts
```

This capability is not auto-installed — opt in by activating
`capKeyboardShortcuts` in your host app.

## Usage

Mount the provider once near your React root:

```tsx
import { ShortcutCheatsheet, ShortcutProvider } from "@linchkit/cap-keyboard-shortcuts";

export function App({ children }: { children: React.ReactNode }) {
  return (
    <ShortcutProvider>
      {children}
      <ShortcutCheatsheet />
    </ShortcutProvider>
  );
}
```

Register a shortcut from any component:

```tsx
import { useShortcut } from "@linchkit/cap-keyboard-shortcuts";

export function SaveButton({ onSave }: { onSave: () => void }) {
  useShortcut({
    keys: "Mod+S",
    description: "Save the current document",
    scope: "Editor",
    handler: () => onSave(),
  });
  return <button onClick={onSave}>Save</button>;
}
```

`Mod` resolves to `Meta` on macOS / iOS and `Ctrl` everywhere else.
Sequences are supported via space-separated chords: `keys: "g h"` fires
after pressing `g` then `h` within one second.

## Cheatsheet binding

`<ShortcutCheatsheet />` opens on `Shift+?` by default. Override or disable:

```tsx
<ShortcutCheatsheet triggerKeys="Mod+/" />
<ShortcutCheatsheet triggerKeys={null} open={isOpen} onOpenChange={setOpen} />
```

## Editable-target bail-out

Shortcuts ignore `keydown` events that originate inside `INPUT`,
`TEXTAREA`, `SELECT`, or `contentEditable` elements — pass
`allowInInput: true` on the registration to opt back in.

## Peer dependencies

- `@linchkit/core` ^0.2.0
- `react` ^19.0.0
- `react-i18next` ^14
