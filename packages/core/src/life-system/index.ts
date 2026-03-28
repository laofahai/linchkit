/**
 * Life-system module -- Sense + Awareness layer public API (Spec 55)
 *
 * Exports the SignalBus factory, defineSensor helper, and awareness engines.
 * Type abstractions live in packages/core/src/types/life-system.ts.
 */

export { createSignalBus } from "./signal-bus";
export type { SignalBus, SignalBusOptions, SignalHandler } from "./signal-bus";

export { defineSensor } from "./define-sensor";
export type { SensorDefinitionConfig } from "./define-sensor";

export { createUsageImportanceGraph } from "./usage-graph";
export { createAttentionBudget } from "./attention-budget";
export { createAwarenessEngine } from "./awareness-engine";
export type { AwarenessEngineOptions } from "./awareness-engine";
