/**
 * defineSensor — factory helper for creating typed Sensor instances (Spec 55 §3.3)
 *
 * Capabilities use this to declare sensors that will be registered via
 * extensions.sensors in their CapabilityDefinition.
 */

import type { Sensor, SensorContext, SensorSignal, SignalSource } from "../types/life-system";

export interface SensorDefinitionConfig<TSignal extends SensorSignal = SensorSignal> {
  /** Unique sensor name within a capability. */
  name: string;
  /** Which system channel this sensor observes. */
  source: SignalSource;
  /** Schema this sensor is scoped to, if any. */
  schema?: string;
  /** Detection function — returns a signal or null if nothing to report. */
  detect: (context: SensorContext) => Promise<TSignal | null>;
}

/**
 * Creates a typed Sensor instance from a plain config object.
 *
 * @example
 * ```ts
 * const mySensor = defineSensor({
 *   name: 'purchase_rejection_pattern',
 *   source: 'event_bus',
 *   schema: 'purchase_request',
 *   async detect(ctx) {
 *     // ... compute value, baseline, deviation, confidence
 *     return { sensor: 'purchase_rejection_pattern', source: 'event_bus', ... };
 *   },
 * });
 * ```
 */
export function defineSensor<TSignal extends SensorSignal = SensorSignal>(
  config: SensorDefinitionConfig<TSignal>,
): Sensor<TSignal> {
  return {
    name: config.name,
    source: config.source,
    schema: config.schema,
    detect: config.detect,
  };
}
