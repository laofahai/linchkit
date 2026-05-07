/**
 * Life-system module — Sense + Memory + Awareness + Insight public API (Spec 55)
 *
 * Exports factories for the full evolution pipeline:
 * SignalBus → MemoryEngine → AwarenessEngine → InsightEngine → EvolutionCycle
 * Type abstractions live in packages/core/src/types/life-system.ts.
 *
 * Spec 56 Phase 2 Step 2a — additional lifecycle-style Sense / Memory
 * abstractions (LifecycleSensor, LifecycleSignal, LifecycleBaseline,
 * LifecycleMemoryStore) live in `./abstractions`. The lifecycle-sensor
 * registry helpers live in `./sensor-registry`.
 */

// Spec 56 Phase 2 Step 2a — lifecycle-style life-system abstractions (additive).
export type {
  LifecycleBaseline,
  LifecycleMemoryStore,
  LifecycleSensor,
  LifecycleSignal,
  MemoryStoreListOptions,
  MemoryStoreListPage,
  MemoryStoreWriteOptions,
  Unsubscribe,
} from "./abstractions";
export { createAttentionBudget } from "./attention-budget";
export type { AwarenessEngineOptions } from "./awareness-engine";
export { createAwarenessEngine } from "./awareness-engine";
export type { SensorDefinitionConfig } from "./define-sensor";
export { defineSensor } from "./define-sensor";
// Spec 56 Phase 2 Step 2c — abstract Detector contract.
// Concrete implementations live in capabilities (cap-ai-provider).
export type { Detector } from "./detector";
export type { CreateDispatchQueryOptions } from "./dispatch-query";
export { createDispatchQuery } from "./dispatch-query";
export type { EvolutionCycleOptions } from "./evolution-cycle";
export { createEvolutionCycle } from "./evolution-cycle";
export { InMemoryMemoryStore } from "./in-memory-memory-store";
export type { InsightEngineOptions } from "./insight-engine";
export { createInsightEngine } from "./insight-engine";
// Spec 55 §7 — Insight → Proposal translator (Slice 1: structural-only).
export type {
  InsightTranslator,
  InsightTranslatorKey,
  InsightTranslatorRegistry,
  TranslatorContext,
} from "./insight-to-proposal";
export {
  createDefaultInsightTranslatorRegistry,
  createInsightTranslatorRegistry,
  insightTranslatorKey,
  schemaNoViewTranslator,
} from "./insight-to-proposal";
export type { MemoryEngineOptions } from "./memory-engine";
export { MemoryEngine } from "./memory-engine";
// Proposal pre-analysis pipeline (Spec 55 §7.3 — dedup + impact)
export type {
  BacktestResult,
  ConflictFinding,
  ConflictResult,
  CreateDedupAnalyzerOptions,
  CreateImpactAnalyzerOptions,
  CreatePreAnalysisPipelineOptions,
  DedupResult,
  ImpactDataProvider,
  ImpactResult,
  PendingProposalStore,
  PreAnalysisPipeline,
  PreAnalysisStage,
  PreAnalysisStageResult,
  PreAnalysisStatus,
  PreAnalyzer,
  ProposalPreAnalysisResult,
} from "./proposal-preanalysis";
export {
  createDedupAnalyzer,
  createImpactAnalyzer,
  createPreAnalysisPipeline,
} from "./proposal-preanalysis";
export type { EvolutionRuntime, EvolutionRuntimeOptions } from "./runtime";
export { createEvolutionRuntime } from "./runtime";
export {
  clearSensors,
  findSensor,
  getSensors,
  registerSensor,
  unregisterSensor,
} from "./sensor-registry";
export type { SignalBus, SignalBusOptions, SignalHandler } from "./signal-bus";
export { createSignalBus } from "./signal-bus";
export { createUsageImportanceGraph } from "./usage-graph";
export type { Watcher } from "./watcher";
