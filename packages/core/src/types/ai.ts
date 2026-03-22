/**
 * AI Service type definitions
 *
 * Unified AI service layer that wraps Vercel AI SDK.
 * Provides model aliasing, usage tracking, and integration with ActionContext.
 *
 * AI calls go through ctx.ai — never import provider SDKs directly.
 * See spec 36_ai_service.md for full design.
 */

import type { ZodSchema } from "zod";

// ── Provider configuration ──────────────────────────────────

/** SDK protocol type for the provider */
export type AIProviderType = "anthropic" | "openai";

export interface AIProviderConfig {
  /** SDK protocol type. Inferred from provider name if omitted:
   * - name "anthropic" → "anthropic"
   * - name "openai" → "openai"
   * - others → must be explicitly set */
  type?: AIProviderType;
  /** API key (or $env.VAR_NAME for environment variable) */
  apiKey?: string;
  /** Custom base URL (required for openai-compatible providers) */
  endpoint?: string;
  /** Default model ID for this provider */
  defaultModel: string;
  /** Model alias mapping: alias → model ID (e.g. fast → claude-haiku-4-5-20251001) */
  models?: Record<string, string>;
}

// ── Global limits ───────────────────────────────────────────

export interface AILimits {
  /** Max tokens per single request */
  maxTokensPerRequest?: number;
  /** Max requests per minute (rate limiting) */
  maxRequestsPerMinute?: number;
  /** Max daily cost in USD (circuit breaker) */
  maxCostPerDay?: number;
}

// ── Top-level AI config ─────────────────────────────────────

export interface AIServiceConfig {
  /** Default provider name (key in providers map) */
  defaultProvider: string;
  /** Provider configurations keyed by name */
  providers: Record<string, AIProviderConfig>;
  /** Global resource limits */
  limits?: AILimits;
}

// ── Completion options ──────────────────────────────────────

export interface AIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AITool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface AIToolCall {
  toolName: string;
  args: Record<string, unknown>;
}

export interface AICompletionOptions {
  /** Provider name override (default: config.defaultProvider) */
  provider?: string;
  /** Model alias (fast/standard/advanced) or full model ID */
  model?: string;
  /** Conversation messages */
  messages: AIMessage[];
  /** Sampling temperature (default: 0) */
  temperature?: number;
  /** Max output tokens */
  maxTokens?: number;
  /** Response format — 'json' requires a Zod schema for structured output */
  responseFormat?: { type: "text" } | { type: "json"; schema: ZodSchema };
  /** Tools available for the model to call */
  tools?: AITool[];
  /** Request timeout in milliseconds */
  timeout?: number;
}

// ── Completion result ───────────────────────────────────────

export interface AICompletionResult {
  /** Raw text content */
  content: string;
  /** Parsed and validated data (when responseFormat.type is 'json') */
  data?: unknown;
  /** Tool calls requested by the model */
  toolCalls?: AIToolCall[];
  /** Token usage statistics */
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    /** Estimated cost in USD */
    cost?: number;
  };
  /** Actual model ID used */
  model: string;
  /** Provider name used */
  provider: string;
  /** Request duration in milliseconds */
  duration: number;
}

// ── AI Service interface ────────────────────────────────────

/** The ctx.ai interface available in Action handlers */
export interface AIService {
  /** Single completion request */
  complete(options: AICompletionOptions): Promise<AICompletionResult>;
}
