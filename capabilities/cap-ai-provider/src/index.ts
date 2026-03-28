/**
 * @linchkit/cap-ai-provider
 *
 * AI Provider capability — Vercel AI SDK implementations for LinchKit.
 *
 * Provides the concrete AI service implementation with:
 * - Anthropic (Claude) provider support
 * - OpenAI and OpenAI-compatible provider support
 * - Cost estimation, response caching, fallback chains, model routing
 *
 * Core (@linchkit/core) retains:
 * - AIService interface and createNoopAIService()
 * - Security layer: AIBoundary, PromptSanitizer, OutputValidator
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

// Cost Estimator
export type { ModelPricing } from "./cost-estimator";
export { CostEstimator, defaultCostEstimator } from "./cost-estimator";

// Response Cache
export { AIResponseCache } from "./response-cache";
