# cap-life-demo

A minimal end-to-end skeleton proving the Spec 55 life-system pipeline runs
through the lifecycle abstractions added in PR #255 — `LifecycleSensor`,
`LifecycleSignal`, `LifecycleMemoryStore`, `LifecycleBaseline`. The demo
intentionally skips databases, HTTP, and AI providers: the Sense -> Memory
flow stays in-process so future capabilities have a copy-pasteable wiring
example.

## Wiring

```ts
import {
  CountingBaseline,
  InMemoryLifecycleStore,
  PollSensor,
  run,
} from "@linchkit/cap-life-demo";

const sensor = new PollSensor({
  id: "my-cap.heartbeat",
  intervalMs: 250,
  produce: () => ({ value: Math.random() }),
});
const store = new InMemoryLifecycleStore();
const baseline = new CountingBaseline({ id: "my-cap.heartbeat.value" });

const controller = run({
  sensor,
  store,
  baseline,
  anomalyThreshold: 0.5,
  onAnomaly: (signal, score) => console.log("spike", signal, score),
});

// later: controller.stop();
```

The pipeline subscribes to the sensor, writes every signal under
`signals/${sensorId}/${timestamp}` in the memory store, and asks the
baseline to score the new value before updating it.

See `docs/specs/55_evolution_system.md` for the five-layer life-system model.
