/**
 * Life-system module — Sense layer public API (Spec 55)
 *
 * Exports the SignalBus factory and defineSensor helper.
 * Type abstractions live in packages/core/src/types/life-system.ts.
 */

export { createSignalBus } from "./signal-bus";
export type { SignalBus, SignalBusOptions, SignalHandler } from "./signal-bus";

export { defineSensor } from "./define-sensor";
export type { SensorDefinitionConfig } from "./define-sensor";
