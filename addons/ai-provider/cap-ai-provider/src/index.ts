/**
 * @linchkit/cap-ai-provider
 *
 * AI Provider capability — Vercel AI SDK implementations for LinchKit.
 *
 * Provides:
 * - Concrete AIService impl: Anthropic (Claude), OpenAI, OpenAI-compatible
 * - Cost estimation, response caching, fallback chains, model routing
 * - PatternDetector and AnomalyDetector (Spec 55 Sense layer impls)
 * - WatcherEngine (Spec 45 reactive automation) — see note below
 *
 * Core (@linchkit/core) retains:
 * - AIService interface and createNoopAIService()
 * - Security layer: AIBoundary, PromptSanitizer, OutputValidator
 * - Detector / Watcher abstract interfaces (Spec 56 Phase 2 Step 2c)
 *
 * **WatcherEngine note**: this engine is conceptually generic data-condition
 * automation, not AI-specific. It is parked here for now (Spec 56 Phase 2
 * Step 2c) since cap-ai-provider was the closest existing capability. If
 * non-AI watcher kinds proliferate, a future PR should split it into a
 * dedicated `cap-watcher` addon.
 *
 * Usage:
 *   import { createAIService } from "@linchkit/cap-ai-provider";
 *   const ai = createAIService(config);
 */

// AI Service (Vercel AI SDK implementation)
export {
  createAIService,
  defaultAIConfig,
  resolveLanguageModel,
  resolveModel,
  resolveModelRoute,
  resolveTenantConfig,
} from "./ai-service";

// Anomaly Detector (moved from @linchkit/core, Spec 56 Phase 2 Step 2c)
export type {
  AnomalyDetection,
  AnomalyDetectorConfig,
  AnomalyDetectorDetectOptions,
  AnomalySeverity,
  AnomalyType,
  UsageEvent,
} from "./anomaly-detector";
export { AnomalyDetector } from "./anomaly-detector";

// Cost Estimator
export type { ModelPricing } from "./cost-estimator";
export { CostEstimator, defaultCostEstimator } from "./cost-estimator";

// Intent Resolver (Spec 52 Phase 0 PoC — natural language → ActionProposal)
export type { ActionCatalogEntry } from "./intent-prompt";
export { buildIntentSystemPrompt } from "./intent-prompt";
export type {
  ActionProposal,
  OntologyRegistryLike,
  ResolveIntentDeps,
  ResolveIntentInput,
} from "./intent-resolver";
export { MIN_CONFIDENCE, resolveIntent } from "./intent-resolver";

// Pattern Detector (moved from @linchkit/core, Spec 56 Phase 2 Step 2c)
export type {
  PatternDetectorConfig,
  PatternEvidence,
  PatternInsight,
  PatternType,
} from "./pattern-detector";
export { PatternDetector } from "./pattern-detector";

// Response Cache
export { AIResponseCache } from "./response-cache";

// Watcher Engine (moved from @linchkit/core, Spec 56 Phase 2 Step 2c)
export {
  createWatcherEngine,
  evaluateComparison,
  parseDuration,
  type WatcherActionExecutor,
  type WatcherDataQuerier,
  type WatcherEngine,
  type WatcherEngineOptions,
} from "./watcher-engine";
