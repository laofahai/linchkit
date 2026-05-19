/**
 * Life-system — Sense layer (Spec 55) + Proposal pre-analysis (Spec 55 §7.3).
 *
 * Spec 56 Phase 2 Step 2a adds lifecycle-style Sensor/Signal/Baseline/MemoryStore
 * abstractions (Lifecycle* prefix) plus the lifecycle-sensor registry helpers
 * (registerSensor & friends). `clearSensors` is intentionally NOT re-exported
 * here — it's a test-only helper, available via `../../life-system` and
 * the sensor-registry module path.
 *
 * Browser-safe surface: types + pure factory functions. AwarenessEngine and
 * other server-only runtime live in ../server/life-system.ts.
 */

export type {
  BacktestResult,
  ConflictFinding,
  ConflictResult,
  CreateDedupAnalyzerOptions,
  CreateImpactAnalyzerOptions,
  CreatePreAnalysisPipelineOptions,
  DedupResult,
  Detector,
  EvolutionRuntime,
  EvolutionRuntimeOptions,
  ImpactDataProvider,
  ImpactResult,
  InsightTranslator,
  InsightTranslatorKey,
  InsightTranslatorRegistry,
  LifecycleBaseline,
  LifecycleMemoryStore,
  LifecycleSensor,
  LifecycleSignal,
  MemoryStoreListOptions,
  MemoryStoreListPage,
  MemoryStoreWriteOptions,
  PendingProposalStore,
  PreAnalysisPipeline,
  PreAnalysisStage,
  PreAnalysisStageResult,
  PreAnalysisStatus,
  PreAnalyzer,
  ProposalPreAnalysisResult,
  SensorDefinitionConfig,
  SignalBus,
  SignalBusOptions,
  SignalHandler,
  TranslatorContext,
  Unsubscribe,
  Watcher,
} from "../../life-system";
export {
  createDedupAnalyzer,
  createDefaultInsightTranslatorRegistry,
  createDispatchQuery,
  createEvolutionRuntime,
  createImpactAnalyzer,
  createInsightTranslatorRegistry,
  createPreAnalysisPipeline,
  createSignalBus,
  defineSensor,
  findSensor,
  getSensors,
  registerSensor,
  unregisterSensor,
} from "../../life-system";
