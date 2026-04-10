---
name: "linch:engine-dev"
description: "Core engine development: interface design, EventBus integration, test patterns, engine registration"
---

# Core Engine Development

For building or modifying core runtime engines (life-system, rule engine, state machine, etc.).
This is NOT for capability development — use `/linch-capability-dev` for that.

## When to Use

- Building new engines (e.g., AwarenessEngine, InsightEngine)
- Modifying existing engines (ActionEngine, RuleEngine, StateMachine)
- Adding core runtime features (new pipeline slots, new event types)
- Life-system work (Sense, Memory, Awareness, Insight, Proposal)

## Workflow

### 1. Read the Spec

Core engines always have specs. Read the spec FIRST:
- Life system → Spec 55 (`docs/specs/55_evolution_system.md`)
- Rule engine → Spec 23
- State machine → Spec 32
- Action/execution → Specs 04, 39
- CommandLayer → Spec 16

### 2. Study Existing Engine Patterns

All core engines follow the same pattern. Read an existing engine to understand:

```text
packages/core/src/
├── engines/
│   ├── action-engine.ts       # ActionEngine — createActionEngine()
│   ├── rule-engine.ts         # RuleEngine — createRuleEngine()
│   └── state-machine.ts       # StateMachine — createStateMachine()
├── life-system/
│   ├── signal-bus.ts          # SignalBus — event backbone
│   ├── awareness-engine.ts    # AwarenessEngine — pattern detection
│   ├── baseline-tracker.ts    # BaselineTracker — statistical baselines
│   └── index.ts               # Public exports
└── types/
    ├── engine.ts              # Engine interfaces
    └── life-system.ts         # Life-system types
```

### 3. Design the Interface First

Every engine MUST have:
- **A TypeScript interface** — in `packages/core/src/types/`
- **A factory function** — `createXxxEngine(options): XxxEngine`
- **No class inheritance** — use composition and factory functions
- **EventBus integration** — engines communicate via events, not direct calls

```ts
// types/my-engine.ts
export interface MyEngine {
  process(input: MyInput): Promise<MyOutput>;
  dispose(): void;
}

export interface MyEngineOptions {
  signalBus: SignalBus;
  store: Store;
  // ... dependencies injected via options
}
```

```ts
// engines/my-engine.ts
export function createMyEngine(options: MyEngineOptions): MyEngine {
  const { signalBus, store } = options;
  // ... implementation
  return { process, dispose };
}
```

### 4. Integration Points

| Integration | How |
|-------------|-----|
| **SignalBus** | `signalBus.emit()` / `signalBus.on()` — engines never call each other directly |
| **Store** | Inject via options, use for persistence |
| **CommandLayer** | If engine affects action execution, register as middleware |
| **Config** | Use `defineConfigSchema()` for engine configuration |
| **Lifecycle** | Register in `server-entry.ts` for boot/shutdown |

### 5. Testing

Core engine tests go in `packages/core/src/__tests__/`:

```ts
import { describe, expect, test } from "bun:test";
import { createMyEngine } from "../../engines/my-engine";
import { createSignalBus } from "../../life-system/signal-bus";
import { InMemoryMemoryStore } from "../../life-system/in-memory-memory-store";

describe("MyEngine", () => {
  test("processes input correctly", async () => {
    const signalBus = createSignalBus();
    const store = new InMemoryMemoryStore();
    const engine = createMyEngine({ signalBus, store });

    const result = await engine.process({ ... });
    expect(result).toEqual({ ... });
  });
});
```

### 6. Core Boundary Check

Before adding to core, verify:
- "Without this, is a zero-capability LinchKit still AI-Native?"
- If YES → this belongs in a capability, not core
- If NO → core is correct

Life-system engines (Sense, Memory, Awareness, Insight, Proposal) are always core — they make LinchKit AI-Native.

## Checklist

- [ ] Spec read and understood
- [ ] TypeScript interface defined in `types/`
- [ ] Factory function `createXxxEngine()` implemented
- [ ] EventBus integration (no direct engine-to-engine calls)
- [ ] Dependencies injected via options object
- [ ] Tests in `__tests__/` with in-memory store
- [ ] Registered in `server-entry.ts` if needed
- [ ] File under 500 lines
- [ ] All quality gates pass
