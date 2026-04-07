# @linchkit/cap-adapter-mcp

MCP (Model Context Protocol) adapter for LinchKit — exposes the Command Layer as MCP tools and resources, enabling AI agents to interact with LinchKit applications.

## Installation

```bash
bun add @linchkit/cap-adapter-mcp
```

## Peer Dependencies

- `@linchkit/core` ^0.1.0

## Usage

### Create MCP Adapter

```ts
import { createCapAdapterMcp } from "@linchkit/cap-adapter-mcp";

const mcp = createCapAdapterMcp({
  runtimeContext: ctx,
});
```

### SSE Transport

```ts
import { createMcpSseServer } from "@linchkit/cap-adapter-mcp";

const sseServer = createMcpSseServer({
  runtimeContext: ctx,
  port: 3002,
});
```

### Tool Generation

```ts
import { generateActionTools, generateBuiltinTools } from "@linchkit/cap-adapter-mcp";

const tools = generateActionTools(actions, entities);
```

### MCP Client Registry

```ts
import { McpClientRegistry } from "@linchkit/cap-adapter-mcp";

const registry = new McpClientRegistry({ store: myStore });
```

## Links

- [Repository](https://github.com/laofahai/linchkit)
