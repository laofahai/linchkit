# @linchkit/cap-chatter

Record timeline capability for LinchKit — provides messages, audit logging, and GraphQL integration for entity-level discussions and activity tracking.

## Installation

```bash
bun add @linchkit/cap-chatter
```

## Peer Dependencies

- `@linchkit/core` ^0.1.0
- `drizzle-orm` ^0.45.1
- `graphql` ^16.13.1

## Usage

### Register the Capability

```ts
import { createCapChatter } from "@linchkit/cap-chatter";

const chatter = createCapChatter({
  // options
});
```

### Auto-log Events

```ts
import { createChatterAutoLog } from "@linchkit/cap-chatter";

const autoLog = createChatterAutoLog();
```

### Service Layer

```ts
import { DrizzleChatterService, InMemoryChatterService } from "@linchkit/cap-chatter";

// With PostgreSQL
const service = new DrizzleChatterService(db);

// Without database
const service = new InMemoryChatterService();
```

## Links

- [Repository](https://github.com/laofahai/linchkit)
