/**
 * Sense -> Memory -> Awareness pipeline wiring for the life-system demo.
 *
 * End-to-end flow:
 *
 *   1. The {@link PollSensor} produces a Signal (`kind: "synthetic.tick"`,
 *      `data: { value: number }`) on each polling tick.
 *
 *   2. The pipeline subscribes to the sensor and writes every Signal to
 *      the {@link InMemoryLifecycleStore} under the key
 *      `signals/${sensorId}/${timestamp}`. This is the Memory write.
 *
 *   3. The pipeline asks the {@link CountingBaseline} to score the new
 *      observation. If the score exceeds `anomalyThreshold`, the
 *      `onAnomaly` callback fires with the offending Signal.
 *
 *   4. The pipeline updates the baseline with the observation so future
 *      ticks score against an up-to-date distribution.
 *
 * `run()` returns a controller exposing:
 *   - `stop()` — unsubscribes from the sensor and stops its timer.
 *   - `tick()` — synchronously drives one observation (test ergonomics).
 *
 * Everything stays in-process. No PostgreSQL, no HTTP, no AI provider.
 */

import type { LifecycleSignal } from "@linchkit/core";
import type { CountingBaseline } from "./counting-baseline";
import type { InMemoryLifecycleStore } from "./in-memory-store";
import type { PollSensor } from "./poll-sensor";

export interface RunPipelineOptions {
  sensor: PollSensor;
  store: InMemoryLifecycleStore;
  baseline: CountingBaseline;
  /** Score (0..1) above which a Signal is treated as anomalous. Default: 0.5. */
  anomalyThreshold?: number;
  /** Called once per Signal whose baseline score exceeds the threshold. */
  onAnomaly?: (signal: LifecycleSignal, score: number) => void;
}

export interface PipelineController {
  /** Stop the sensor and unsubscribe from its signal stream. Idempotent. */
  stop(): void;
  /** Drive one synchronous tick — emits a signal and processes it inline. */
  tick(): Promise<void>;
  /** Whether the pipeline is currently running. */
  isRunning(): boolean;
}

export function run(options: RunPipelineOptions): PipelineController {
  const { sensor, store, baseline, anomalyThreshold = 0.5, onAnomaly } = options;
  let stopped = false;
  // Monotonic counter so two ticks landing in the same millisecond (or any
  // test using a fixed `now()`) produce distinct keys instead of silently
  // overwriting each other.
  let seq = 0;

  const handle = async (signal: LifecycleSignal) => {
    // Step 2: write the Signal to the Memory layer.
    const key = `signals/${sensor.id}/${signal.timestamp}/${++seq}`;
    await store.write(key, signal);

    // Step 3: score against the baseline; fire the anomaly hook if needed.
    const score = await Promise.resolve(baseline.score(signal.data));
    if (onAnomaly && score > anomalyThreshold) {
      onAnomaly(signal, score);
    }

    // Step 4: update the baseline with the new observation.
    await Promise.resolve(baseline.update(signal.data));
  };

  // We capture the most recent in-flight handle promise so the
  // synchronous `tick()` helper can await it deterministically. The
  // `subscribe` callback intentionally has no async surface, so this
  // shared reference is the only way to bridge it back out for tests.
  let inflight: Promise<void> = Promise.resolve();

  const unsubscribe = sensor.subscribe((signal) => {
    // Errors from a single observation must not poison the stream.
    inflight = handle(signal).catch(() => {
      // Future revisions can route this into the Signal bus as a
      // pipeline.error event; for the demo we swallow.
    });
  });

  sensor.start();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      unsubscribe();
      sensor.stop();
    },
    async tick() {
      // Drive a single emit; the subscribe handler above starts the
      // handle() promise and assigns it to `inflight`. Awaiting that
      // promise lets tests observe the post-state synchronously.
      sensor.emitOnce();
      await inflight;
    },
    isRunning() {
      return !stopped;
    },
  };
}
