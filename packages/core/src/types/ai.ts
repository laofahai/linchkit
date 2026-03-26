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

// ── Fallback chain ───────────────────────────────────────────

/** Fallback provider specification for multi-model resilience */
export interface AIFallbackConfig {
  /** Ordered list of provider names to try when primary fails */
  providers: string[];
  /** Max retries per provider before moving to next (default: 1) */
  retriesPerProvider?: number;
  /** Delay in ms between retries (default: 1000) */
  retryDelay?: number;
  /** Only fallback on these error types (default: all errors trigger fallback) */
  onErrors?: ("timeout" | "rate_limit" | "server_error" | "auth_error")[];
}

// ── Model routing ────────────────────────────────────────────

/** Task type for model routing */
export type AITaskType =
  | "classification"
  | "extraction"
  | "generation"
  | "summarization"
  | "analysis"
  | "conversation"
  | "code";

/** Model routing rule: map task types to model tiers */
export interface AIModelRoute {
  /** Task type this route applies to */
  taskType: AITaskType;
  /** Model alias or ID to use for this task type */
  model: string;
  /** Provider override for this task type */
  provider?: string;
}

// ── Response caching ─────────────────────────────────────────

/** Configuration for AI response caching */
export interface AICacheConfig {
  /** Enable response caching (default: false) */
  enabled: boolean;
  /** Max number of cached entries (default: 1000) */
  maxEntries?: number;
  /** TTL in milliseconds for cached entries (default: 3600000 = 1 hour) */
  ttlMs?: number;
  /** Only cache responses for these model aliases (default: all) */
  modelFilter?: string[];
}

// ── Tenant AI config override ────────────────────────────────

/** Per-tenant AI configuration override (BYOK support) */
export interface AITenantConfig {
  /** Override provider configs (merged with global) */
  providers?: Record<string, Partial<AIProviderConfig>>;
  /** Override limits for this tenant */
  limits?: AILimits;
  /** Fallback chain override for this tenant */
  fallback?: AIFallbackConfig;
}

// ── Top-level AI config ─────────────────────────────────────

export interface AIServiceConfig {
  /** Default provider name (key in providers map) */
  defaultProvider: string;
  /** Provider configurations keyed by name */
  providers: Record<string, AIProviderConfig>;
  /** Global resource limits */
  limits?: AILimits;
  /** Fallback chain configuration */
  fallback?: AIFallbackConfig;
  /** Model routing rules (task type → model mapping) */
  routing?: AIModelRoute[];
  /** Response caching configuration */
  cache?: AICacheConfig;
  /** Per-tenant AI config overrides (BYOK) */
  tenants?: Record<string, AITenantConfig>;
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
  /** Task type hint for model routing (auto-selects model tier) */
  taskType?: AITaskType;
  /** Tenant ID for BYOK config resolution */
  tenantId?: string;
  /** Whether to use response cache (default: follows global cache config) */
  cache?: boolean;
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
  /** Whether this result was served from cache */
  cached?: boolean;
  /** Whether a fallback provider was used (includes original provider that failed) */
  fallbackUsed?: string;
}

// ── Streaming result ─────────────────────────────────────────

/** A streaming completion result — yields text chunks via async iterator */
export interface AIStreamResult {
  /** Async iterator of text chunks */
  textStream: AsyncIterable<string>;
  /** Actual model ID used */
  model: string;
  /** Provider name used */
  provider: string;
}

// ── AI Service interface ────────────────────────────────────

/** The ctx.ai interface available in Action handlers */
export interface AIService {
  /** Whether a real AI provider is configured (false for noop) */
  configured: boolean;
  /** Single completion request */
  complete(options: AICompletionOptions): Promise<AICompletionResult>;
  /** Streaming completion request — returns an async iterable of text chunks */
  completeStream?(options: AICompletionOptions): Promise<AIStreamResult>;
}
