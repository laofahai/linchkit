# @linchkit/core

Core runtime for LinchKit — an AI-Native Software Capability Runtime. Provides types, engines, pipeline, define functions, and the meta-model primitives (Entity, Action, Rule, State, Event, EventHandler, View, Flow, Relation).

## Installation

```bash
bun add @linchkit/core
```

## Usage

### Define an Entity

```ts
import { defineEntity } from "@linchkit/core";

const order = defineEntity({
  name: "order",
  fields: [
    { name: "title", type: "string", required: true },
    { name: "amount", type: "number" },
    { name: "status", type: "string" },
  ],
});
```

### Define an Action

```ts
import { defineAction } from "@linchkit/core";

const submitOrder = defineAction({
  name: "submit_order",
  entity: "order",
  input: [{ name: "title", type: "string", required: true }],
  handler: async ({ input, data }) => {
    return data.create("order", input);
  },
});
```

### Define a Capability

```ts
import { defineCapability } from "@linchkit/core";

const myCapability = defineCapability({
  name: "my-capability",
  entities: [order],
  actions: [submitOrder],
});
```

## Entry Points

| Path | Description |
|------|-------------|
| `@linchkit/core` | Browser-safe: types, define functions, errors, config |
| `@linchkit/core/server` | Server-only: engines, database, event bus, flow |
| `@linchkit/core/types` | Type-only exports |
| `@linchkit/core/define` | Define functions + errors + Zod generator |
| `@linchkit/core/config` | Configuration registry |
| `@linchkit/core/ai` | AI boundary and security layer |

## Links

- [Repository](https://github.com/laofahai/linchkit)
