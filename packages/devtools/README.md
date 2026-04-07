# @linchkit/devtools

Testing utilities and development tools for LinchKit — rule testing, state machine testing, capability validation, documentation generation, and code quality checks.

## Installation

```bash
bun add -D @linchkit/devtools
```

## Usage

### Test a Rule

```ts
import { testRule } from "@linchkit/devtools";

const result = testRule({
  rule: myRule,
  input: { entity: "order", data: { amount: 100 } },
});
```

### Test a State Machine

```ts
import { testStateMachine, getAvailableTransitions } from "@linchkit/devtools";

const result = testStateMachine({
  state: orderState,
  currentState: "draft",
  event: "submit",
});

const transitions = getAvailableTransitions({
  state: orderState,
  currentState: "draft",
});
```

### Validate a Capability

```ts
import { validateCapability } from "@linchkit/devtools";

const result = validateCapability(myCapability);
```

### Create a Test Runtime

```ts
import { createTestRuntime } from "@linchkit/devtools";

const runtime = createTestRuntime({
  capabilities: [myCapability],
});
```

## Sub-entry Points

| Path | Description |
|------|-------------|
| `@linchkit/devtools` | Test utilities, validation |
| `@linchkit/devtools/documentation` | API doc generation, OpenAPI, Markdown |
| `@linchkit/devtools/methodology` | Code quality, naming convention checks |
| `@linchkit/devtools/governance` | Doc completeness, spec tracking, changelog |

## Links

- [Repository](https://github.com/laofahai/linchkit)
