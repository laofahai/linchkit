/**
 * Life-system runtime — awareness engine, attention budget, signal bus,
 * evolution runtime (Spec 55 / Spec 56). Server-only adds.
 */

export type {
  AwarenessEngineOptions,
  EvolutionRuntime,
  EvolutionRuntimeOptions,
  SensorDefinitionConfig,
  SignalBus,
  SignalBusOptions,
  SignalHandler,
} from "../../life-system";
export {
  createAttentionBudget,
  createAwarenessEngine,
  createDispatchQuery,
  createEvolutionRuntime,
  createSignalBus,
  createUsageImportanceGraph,
  defineSensor,
} from "../../life-system";
