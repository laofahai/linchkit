/**
 * Life-system module — Sense + Memory + Awareness + Insight public API (Spec 55)
 *
 * Exports factories for the full evolution pipeline:
 * SignalBus → MemoryEngine → AwarenessEngine → InsightEngine → EvolutionCycle
 * Type abstractions live in packages/core/src/types/life-system.ts.
 */

export { createAttentionBudget } from "./attention-budget";
export type { AwarenessEngineOptions } from "./awareness-engine";
export { createAwarenessEngine } from "./awareness-engine";
export type { SensorDefinitionConfig } from "./define-sensor";
export { defineSensor } from "./define-sensor";
export type { CreateDispatchQueryOptions } from "./dispatch-query";
export { createDispatchQuery } from "./dispatch-query";
export type { EvolutionCycleOptions } from "./evolution-cycle";
export { createEvolutionCycle } from "./evolution-cycle";
export { InMemoryMemoryStore } from "./in-memory-memory-store";
export type { InsightEngineOptions } from "./insight-engine";
export { createInsightEngine } from "./insight-engine";
export type { MemoryEngineOptions } from "./memory-engine";
export { MemoryEngine } from "./memory-engine";
export type { EvolutionRuntime, EvolutionRuntimeOptions } from "./runtime";
export { createEvolutionRuntime } from "./runtime";
export type { SignalBus, SignalBusOptions, SignalHandler } from "./signal-bus";
export { createSignalBus } from "./signal-bus";
export { createUsageImportanceGraph } from "./usage-graph";
