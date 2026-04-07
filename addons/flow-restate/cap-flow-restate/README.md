# @linchkit/cap-flow-restate

Restate durable flow engine for LinchKit — provides durable workflow execution backed by [Restate](https://restate.dev/). Includes flow compilation, endpoint management, and health checks.

## Installation

```bash
bun add @linchkit/cap-flow-restate
```

## Peer Dependencies

- `@linchkit/core` ^0.1.0

## Usage

### Create Flow Engine

```ts
import { createRestateFlowEngine } from "@linchkit/cap-flow-restate";

const flowEngine = createRestateFlowEngine({
  restateUrl: "http://localhost:8080",
  endpointPort: 9080,
});
```

### Setup Restate Endpoint

```ts
import { setupRestateEndpoint, registerDeployment } from "@linchkit/cap-flow-restate";

const endpoint = setupRestateEndpoint({ port: 9080 });
await registerDeployment({ restateUrl: "http://localhost:8080", endpointUrl: "http://localhost:9080" });
```

### Compile a Flow

```ts
import { compileFlow } from "@linchkit/cap-flow-restate";

const compiled = compileFlow(myFlowDefinition);
```

### Health Check

```ts
import { checkRestateHealth } from "@linchkit/cap-flow-restate";

const healthy = await checkRestateHealth("http://localhost:8080");
```

## Links

- [Repository](https://github.com/laofahai/linchkit)
