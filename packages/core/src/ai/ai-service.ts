/**
 * AI Service — Core noop fallback
 *
 * Core keeps the AIService contract (see types/ai.ts) plus a no-op factory
 * used when AI is not configured. The Vercel AI SDK provider implementation,
 * config helpers, and model resolution live in @linchkit/cap-ai-provider.
 *
 * See spec 36_ai_service.md and spec 56_core_slimming.md.
 */

import type { AIService } from "../types/ai";

/**
 * Create a no-op AIService that throws on any call.
 * Used when AI is not configured — graceful degradation.
 */
export function createNoopAIService(): AIService {
  return {
    configured: false,
    defaultProvider: null,
    providerNames: [],
    complete: () => {
      throw new Error("AI service is not configured. Add an 'ai' section to your LinchKit config.");
    },
  };
}
