/**
 * SignalBus — central hub for Sensor signal distribution (Spec 55 §3.4)
 *
 * Collects SensorSignal emissions from registered sensors and distributes
 * them to subscribers. Operates in-process; a persistent variant can be
 * layered on top via a MemoryStore capability.
 */

import { consoleLogger } from "../observability/console-logger";
import type { Sensor, SensorContext, SensorSignal } from "../types/life-system";

export type SignalHandler = (signal: SensorSignal) => void | Promise<void>;

export interface SignalBusOptions {
  /** Called when a sensor throws during detect(). Defaults to consoleLogger.error. */
  onError?: (sensor: string, error: unknown) => void;
}

/**
 * In-process pub/sub bus for SensorSignal values.
 *
 * Usage:
 *   const bus = createSignalBus();
 *   bus.subscribe(signal => { ... });
 *   bus.registerSensor(mySensor);
 *   const signals = await bus.collectSignals(ctx);
 */
export interface SignalBus {
  /** Register a sensor with this bus. */
  registerSensor(sensor: Sensor): void;
  /** Remove a previously registered sensor by name. */
  unregisterSensor(name: string): void;
  /** Subscribe to signals emitted by this bus. Returns an unsubscribe function. */
  subscribe(handler: SignalHandler): () => void;
  /**
   * Run all registered sensors against the provided context.
   * Returns all non-null results and also publishes them to subscribers.
   */
  collectSignals(ctx: SensorContext): Promise<SensorSignal[]>;
  /** Emit a signal directly (bypasses sensor.detect). */
  emit(signal: SensorSignal): Promise<void>;
  /** List names of currently registered sensors. */
  listSensors(): string[];
}

export function createSignalBus(options: SignalBusOptions = {}): SignalBus {
  const sensors = new Map<string, Sensor>();
  const subscribers: SignalHandler[] = [];

  const onError =
    options.onError ??
    ((sensor, err) => {
      consoleLogger.error(`[SignalBus] sensor "${sensor}" failed: ${err}`);
    });

  async function emit(signal: SensorSignal): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const handler of subscribers) {
      const result = handler(signal);
      if (result instanceof Promise) {
        promises.push(result);
      }
    }
    if (promises.length > 0) {
      await Promise.all(promises);
    }
  }

  return {
    registerSensor(sensor: Sensor): void {
      sensors.set(sensor.name, sensor);
    },

    unregisterSensor(name: string): void {
      sensors.delete(name);
    },

    subscribe(handler: SignalHandler): () => void {
      subscribers.push(handler);
      return () => {
        const idx = subscribers.indexOf(handler);
        if (idx !== -1) subscribers.splice(idx, 1);
      };
    },

    async collectSignals(ctx: SensorContext): Promise<SensorSignal[]> {
      const results: SensorSignal[] = [];
      for (const [name, sensor] of sensors) {
        try {
          const signal = await sensor.detect(ctx);
          if (signal !== null && signal !== undefined) {
            const sensorSignal = signal as SensorSignal;
            results.push(sensorSignal);
            await emit(sensorSignal);
          }
        } catch (err) {
          onError(name, err);
        }
      }
      return results;
    },

    emit,

    listSensors(): string[] {
      return Array.from(sensors.keys());
    },
  };
}
