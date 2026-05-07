/**
 * LifecycleSensor that emits a synthetic "tick" Signal on a fixed interval.
 *
 * Calls a caller-supplied `produce()` function each tick to pick the
 * payload value. This lets tests inject deterministic sequences (normal
 * values then a spike) without faking timers — the test simply provides
 * a generator and steps the timer manually via the polling interval.
 *
 * `start()` / `stop()` are idempotent. Subscribers added before `start()`
 * still receive every signal once the sensor is running.
 */

import type { LifecycleSensor, LifecycleSignal, Unsubscribe } from "@linchkit/core";

export interface PollSensorOptions {
  /** Stable sensor ID — conventionally `<capability>.<sensor_name>`. */
  id: string;
  /** Polling interval in milliseconds. */
  intervalMs: number;
  /** Producer for the next signal payload. Called once per tick. */
  produce: () => { value: number };
  /** Optional source channel; defaults to "synthetic". */
  source?: string;
  /** Optional kind discriminator; defaults to "synthetic.tick". */
  kind?: string;
  /** Optional clock — defaults to Date.now. Allows deterministic tests. */
  now?: () => number;
}

export class PollSensor implements LifecycleSensor {
  readonly id: string;
  private readonly intervalMs: number;
  private readonly produce: () => { value: number };
  private readonly source: string;
  private readonly kind: string;
  private readonly now: () => number;
  private readonly handlers = new Set<(signal: LifecycleSignal) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: PollSensorOptions) {
    this.id = options.id;
    this.intervalMs = options.intervalMs;
    this.produce = options.produce;
    this.source = options.source ?? "synthetic";
    this.kind = options.kind ?? "synthetic.tick";
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer !== null) return; // Idempotent.
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer === null) return; // Idempotent.
    clearInterval(this.timer);
    this.timer = null;
  }

  subscribe(handler: (signal: LifecycleSignal) => void): Unsubscribe {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /**
   * Emit a single signal immediately. Exposed so tests can drive the
   * pipeline deterministically without waiting on real timers.
   */
  emitOnce(): LifecycleSignal {
    return this.tick();
  }

  /** Test helper — number of currently registered subscribers. */
  subscriberCount(): number {
    return this.handlers.size;
  }

  /** Test helper — whether the polling timer is active. */
  isRunning(): boolean {
    return this.timer !== null;
  }

  private tick(): LifecycleSignal {
    const payload = this.produce();
    const signal: LifecycleSignal = {
      source: this.source,
      kind: this.kind,
      data: payload,
      timestamp: this.now(),
      metadata: { sensorId: this.id },
    };
    // Snapshot the handler set before iterating so a subscriber registered
    // *during* delivery doesn't get the current signal — that contradicts the
    // documented "subscribers added before start() see every signal" contract
    // and creates surprising reentrant behavior.
    for (const handler of [...this.handlers]) {
      // Each subscriber is isolated: a throw in one handler must not interrupt
      // delivery to the others or kill the polling loop. Errors get logged
      // (the demo uses console.error; a real impl would route to telemetry).
      try {
        handler(signal);
      } catch (err) {
        console.error(`[PollSensor] Handler error in sensor ${this.id}:`, err);
      }
    }
    return signal;
  }
}
