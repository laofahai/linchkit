# @linchkit/ui-kit

Shadcn-based UI component library for LinchKit — pre-configured with Radix, Lucide icons, and Tailwind CSS. Provides foundational UI primitives used by `@linchkit/cap-adapter-ui`.

## Installation

```bash
bun add @linchkit/ui-kit
```

## Peer Dependencies

- `react` ^19.0.0
- `react-dom` ^19.0.0

## Usage

```tsx
import { Button, Card, CardHeader, CardTitle, CardContent } from "@linchkit/ui-kit/components";
import { cn } from "@linchkit/ui-kit/lib/utils";
import { useTheme } from "@linchkit/ui-kit/hooks";
import "@linchkit/ui-kit/styles.css";
```

### Available Components

Alert, AlertDialog, Avatar, Badge, Breadcrumb, Button, Calendar, Card, Checkbox, Collapsible, Command, Dialog, DropdownMenu, Input, InputGroup, Label, Popover, Select, Separator, Sheet, Sidebar, Skeleton, Slider, Sonner (Toast), Switch, Table, Tabs, Textarea, Tooltip.

### Hooks

- `useIsMobile` — responsive breakpoint detection
- `useTheme` — theme state management

## Links

- [Repository](https://github.com/laofahai/linchkit)
