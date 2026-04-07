# @linchkit/cap-chatter-ui

React UI panel for the LinchKit Chatter capability — provides a record-detail tab for displaying messages and activity timelines. Auto-installs when `@linchkit/cap-adapter-ui` and `@linchkit/cap-chatter` are present.

## Installation

```bash
bun add @linchkit/cap-chatter-ui
```

## Peer Dependencies

- `@linchkit/core` ^0.1.0
- `@linchkit/cap-adapter-ui` ^0.1.0
- `@linchkit/ui-kit` ^0.1.0
- `react` ^19.0.0

## Usage

```ts
import { capChatterUi } from "@linchkit/cap-chatter-ui";

// Register in your capability list — the panel auto-registers
// via the record panel registry on import.
```

The chatter panel automatically registers itself as a "Chatter" tab in entity record detail views.

## Links

- [Repository](https://github.com/laofahai/linchkit)
