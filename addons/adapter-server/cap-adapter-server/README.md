# @linchkit/cap-adapter-server

HTTP server adapter for LinchKit — built on Elysia and graphql-yoga. Provides REST endpoints, GraphQL schema generation, CRUD action generation, SSE subscriptions, and the runtime context.

## Installation

```bash
bun add @linchkit/cap-adapter-server
```

## Peer Dependencies

- `@linchkit/core` ^0.1.0

## Usage

```ts
import { createServer, createRuntimeContext } from "@linchkit/cap-adapter-server";

// Create runtime context with your capabilities
const ctx = createRuntimeContext({
  capabilities: [myCapability],
});

// Start the server
const server = createServer({
  runtimeContext: ctx,
  port: 3001,
});
```

### GraphQL Schema Generation

```ts
import { buildGraphQLSchema, generateCrudActions } from "@linchkit/cap-adapter-server";

const schema = buildGraphQLSchema({
  entities: ctx.entities,
  actions: ctx.actions,
});
```

### Use as a Capability

```ts
import { capAdapterServer } from "@linchkit/cap-adapter-server/capability";
```

## Links

- [Repository](https://github.com/laofahai/linchkit)
