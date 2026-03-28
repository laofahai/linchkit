/**
 * AI Service — Vercel AI SDK implementation
 *
 * Capability-level implementation of the AIService interface from @linchkit/core.
 * Provides:
 * 1. Model alias resolution (fast/standard/advanced → provider + model ID)
 * 2. Unified multi-provider interface (Anthropic, OpenAI, OpenAI-compatible)
 * 3. Usage tracking and cost estimation
 * 4. Multi-model fallback chain (resilience)
 * 5. Response caching for identical prompts
 * 6. Model routing by task type
 * 7. Tenant-level config overrides (BYOK)
 *
 * Core retains: AIService interface, createNoopAIService, security layer.
 * This capability provides the concrete Vercel AI SDK implementation.
 *
 * See spec 36_ai_service.md for full design.
 */

import type {
  AICacheConfig,
  AICompletionOptions,
  AICompletionResult,
  AIFallbackConfig,
  AIModelRoute,
  AIProviderConfig,
  AIProviderType,
  AIService,
  AIServiceConfig,
  AIStreamResult,
  AITaskType,
  AITenantConfig,
  AIToolCall,
} from "@linchkit/core";
import { CostEstimator } from "./cost-estimator";
import { AIResponseCache } from "./response-cache";

/** Infer provider type from well-known provider names */
function inferProviderType(name: string): AIProviderType | undefined {
  if (name === "anthropic") return "anthropic";
  if (name === "openai") return "openai";
  return undefined;
}

// ── Resolved model info ─────────────────────────────────────

interface ResolvedModel {
  provider: string;
  modelId: string;
}

// ── Default configuration ───────────────────────────────────

export const defaultAIConfig: AIServiceConfig = {
  defaultProvider: "anthropic",
  providers: {
    anthropic: {
      defaultModel: "claude-sonnet-4-20250514",
      models: {
        fast: "claude-haiku-4-5-20251001",
        standard: "claude-sonnet-4-20250514",
        advanced: "claude-opus-4-20250514",
      },
    },
  },
};

// ── AIServiceImpl ───────────────────────────────────────────

/**
 * Create an AIService instance backed by the Vercel AI SDK.
 *
 * The service is optional — if no config is provided, use createNoopAIService()
 * from @linchkit/core instead. The system works without AI.
 */
export function createAIService(config: AIServiceConfig): AIService {
  validateConfig(config);

  const costEstimator = new CostEstimator();
  const cache =
    config.cache?.enabled ? new AIResponseCache(config.cache) : undefined;

  return {
    configured: true,
    defaultProvider: config.defaultProvider,
    providerNames: Object.keys(config.providers),
    complete: (options) =>
      executeWithFallback(config, options, costEstimator, cache),
    completeStream: (options) =>
      executeStream(config, options),
  };
}

// ── Config validation ───────────────────────────────────────

function validateConfig(config: AIServiceConfig): void {
  if (!config.defaultProvider) {
    throw new Error("AIServiceConfig.defaultProvider is required");
  }
  if (!config.providers || Object.keys(config.providers).length === 0) {
    throw new Error("AIServiceConfig.providers must have at least one provider");
  }
  if (!config.providers[config.defaultProvider]) {
    throw new Error(`Default provider "${config.defaultProvider}" is not defined in providers`);
  }
  for (const [name, provider] of Object.entries(config.providers)) {
    if (!provider.defaultModel) {
      throw new Error(`Provider "${name}" must have a defaultModel`);
    }
    // Resolve provider type from explicit type or infer from name
    const resolvedType = provider.type ?? inferProviderType(name);
    if (!resolvedType) {
      throw new Error(
        `Provider "${name}" must have an explicit 'type' field ("anthropic" | "openai")`,
      );
    }
    // Custom providers (non-built-in names) require an endpoint
    if (!inferProviderType(name) && !provider.endpoint) {
      throw new Error(`Provider "${name}" requires an 'endpoint' field`);
    }
  }
}

// ── Model resolution ────────────────────────────────────────

/**
 * Resolve a model alias or ID to a provider + model ID pair.
 *
 * Resolution order:
 * 1. If model is undefined → default provider + default model
 * 2. Check if model is an alias in the specified/default provider
 * 3. Treat as literal model ID on the specified/default provider
 */
export function resolveModel(
  config: AIServiceConfig,
  providerName?: string,
  modelAlias?: string,
): ResolvedModel {
  const provider = providerName ?? config.defaultProvider;
  const providerConfig = config.providers[provider];

  if (!providerConfig) {
    throw new Error(`Unknown AI provider: "${provider}"`);
  }

  if (!modelAlias) {
    return { provider, modelId: providerConfig.defaultModel };
  }

  // Check alias map first
  if (providerConfig.models?.[modelAlias]) {
    return { provider, modelId: providerConfig.models[modelAlias] };
  }

  // Treat as literal model ID
  return { provider, modelId: modelAlias };
}

// ── Model routing ────────────────────────────────────────────

/**
 * Resolve model and provider from task type routing rules.
 * Returns undefined if no routing rule matches the task type.
 */
export function resolveModelRoute(
  routes: AIModelRoute[] | undefined,
  taskType: AITaskType,
): { model: string; provider?: string } | undefined {
  if (!routes) return undefined;
  const route = routes.find((r) => r.taskType === taskType);
  if (!route) return undefined;
  return { model: route.model, provider: route.provider };
}

// ── Tenant config resolution ─────────────────────────────────

/**
 * Merge tenant-level AI config overrides with global config.
 * Tenant config can override providers (BYOK), limits, and fallback.
 */
export function resolveTenantConfig(
  globalConfig: AIServiceConfig,
  tenantId: string,
): AIServiceConfig {
  const tenantOverride = globalConfig.tenants?.[tenantId];
  if (!tenantOverride) return globalConfig;

  return mergeTenantConfig(globalConfig, tenantOverride);
}

function mergeTenantConfig(
  global: AIServiceConfig,
  tenant: AITenantConfig,
): AIServiceConfig {
  // Merge provider configs: tenant overrides specific fields per provider
  const mergedProviders = { ...global.providers };
  if (tenant.providers) {
    for (const [name, override] of Object.entries(tenant.providers)) {
      if (mergedProviders[name]) {
        mergedProviders[name] = { ...mergedProviders[name], ...override } as AIProviderConfig;
      }
    }
  }

  return {
    ...global,
    providers: mergedProviders,
    limits: tenant.limits ?? global.limits,
    fallback: tenant.fallback ?? global.fallback,
  };
}

// ── Provider instantiation ──────────────────────────────────

/**
 * Create a Vercel AI SDK LanguageModel for the given provider.
 *
 * Lazily imports provider SDKs so they are only loaded when needed.
 * API keys are resolved from config or environment variables.
 */
async function getLanguageModel(
  config: AIServiceConfig,
  resolved: ResolvedModel,
  // biome-ignore lint/suspicious/noExplicitAny: Vercel AI SDK LanguageModel is generic
): Promise<any> {
  const providerConfig = config.providers[resolved.provider];

  if (!providerConfig) {
    throw new Error(`Unknown AI provider: "${resolved.provider}"`);
  }

  // Resolve API key: config value, or fallback to env var
  const resolveApiKey = (envVar: string): string | undefined => {
    if (providerConfig.apiKey) {
      // Support $env.VAR_NAME syntax from config
      if (providerConfig.apiKey.startsWith("$env.")) {
        const varName = providerConfig.apiKey.slice(5);
        return process.env[varName];
      }
      return providerConfig.apiKey;
    }
    return process.env[envVar];
  };

  // Resolve provider type: explicit type > inferred from name
  const providerType = providerConfig.type ?? inferProviderType(resolved.provider);

  switch (providerType) {
    case "anthropic": {
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      const apiKey = resolveApiKey("ANTHROPIC_API_KEY");
      const anthropic = createAnthropic({
        apiKey,
        ...(providerConfig.endpoint ? { baseURL: providerConfig.endpoint } : {}),
      });
      return anthropic(resolved.modelId);
    }

    case "openai": {
      const { createOpenAI } = await import("@ai-sdk/openai");
      const envVar = inferProviderType(resolved.provider)
        ? "OPENAI_API_KEY"
        : `${resolved.provider.toUpperCase()}_API_KEY`;
      const apiKey = resolveApiKey(envVar);
      const isThirdParty = !inferProviderType(resolved.provider);
      const openai = createOpenAI({
        apiKey: apiKey ?? "",
        ...(providerConfig.endpoint ? { baseURL: providerConfig.endpoint } : {}),
      });
      // Third-party OpenAI-compatible providers use /chat/completions,
      // not the OpenAI Responses API (/responses)
      return isThirdParty ? openai.chat(resolved.modelId) : openai(resolved.modelId);
    }

    default:
      throw new Error(
        `Provider "${resolved.provider}" has no 'type' — set type to "anthropic" or "openai"`,
      );
  }
}

/**
 * Resolve a Vercel AI SDK LanguageModel from config + model alias.
 *
 * Public wrapper around getLanguageModel for direct use with streamText/generateText
 * in transport adapters (e.g., the chat endpoint).
 */
export async function resolveLanguageModel(
  config: AIServiceConfig,
  modelAlias?: string,
  providerName?: string,
  // biome-ignore lint/suspicious/noExplicitAny: Vercel AI SDK LanguageModel is generic
): Promise<any> {
  const resolved = resolveModel(config, providerName, modelAlias);
  return getLanguageModel(config, resolved);
}

// ── Fallback chain execution ─────────────────────────────────

/**
 * Execute completion with fallback chain support.
 * Tries the primary provider first, then falls back through configured providers.
 */
async function executeWithFallback(
  config: AIServiceConfig,
  options: AICompletionOptions,
  costEstimator: CostEstimator,
  cache: AIResponseCache | undefined,
): Promise<AICompletionResult> {
  // Resolve tenant-specific config if tenantId is specified
  const effectiveConfig = options.tenantId
    ? resolveTenantConfig(config, options.tenantId)
    : config;

  // Apply model routing if taskType is specified and no explicit model
  let resolvedOptions = options;
  if (options.taskType && !options.model) {
    const route = resolveModelRoute(effectiveConfig.routing, options.taskType);
    if (route) {
      resolvedOptions = {
        ...options,
        model: route.model,
        provider: route.provider ?? options.provider,
      };
    }
  }

  // Check cache first
  if (cache && resolvedOptions.cache !== false) {
    const cached = cache.get(resolvedOptions);
    if (cached) return cached;
  }

  const fallback = effectiveConfig.fallback;
  if (!fallback || fallback.providers.length === 0) {
    // No fallback chain — execute directly
    const result = await executeCompletion(effectiveConfig, resolvedOptions, costEstimator);
    cache?.set(resolvedOptions, result);
    return result;
  }

  // Build provider attempt list: primary first, then fallback providers
  const primaryProvider = resolvedOptions.provider ?? effectiveConfig.defaultProvider;
  const providerChain = [
    primaryProvider,
    ...fallback.providers.filter((p) => p !== primaryProvider),
  ];
  const retriesPerProvider = fallback.retriesPerProvider ?? 1;
  const retryDelay = fallback.retryDelay ?? 1000;

  let lastError: Error | undefined;
  let failedPrimary: string | undefined;

  for (const providerName of providerChain) {
    // Skip providers not in config
    if (!effectiveConfig.providers[providerName]) continue;

    for (let attempt = 0; attempt < retriesPerProvider; attempt++) {
      try {
        const attemptOptions = { ...resolvedOptions, provider: providerName };
        const result = await executeCompletion(effectiveConfig, attemptOptions, costEstimator);

        // Mark if fallback was used
        if (failedPrimary) {
          result.fallbackUsed = failedPrimary;
        }

        cache?.set(resolvedOptions, result);
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Check if this error type should trigger fallback
        if (fallback.onErrors && !shouldFallback(lastError, fallback.onErrors)) {
          throw lastError;
        }

        if (!failedPrimary) failedPrimary = providerName;

        // Delay between retries (not before the very first attempt)
        if (attempt < retriesPerProvider - 1 || providerChain.indexOf(providerName) < providerChain.length - 1) {
          await sleep(retryDelay);
        }
      }
    }
  }

  // All providers exhausted
  throw new Error(
    `All AI providers failed. Last error: ${lastError?.message ?? "unknown"}`,
  );
}

/**
 * Check if an error should trigger fallback based on error type filters.
 */
function shouldFallback(
  error: Error,
  onErrors: ("timeout" | "rate_limit" | "server_error" | "auth_error")[],
): boolean {
  const msg = error.message.toLowerCase();
  const name = error.name.toLowerCase();

  for (const errorType of onErrors) {
    switch (errorType) {
      case "timeout":
        if (msg.includes("timeout") || msg.includes("timed out") || name.includes("abort")) {
          return true;
        }
        break;
      case "rate_limit":
        if (msg.includes("rate limit") || msg.includes("429") || msg.includes("too many")) {
          return true;
        }
        break;
      case "server_error":
        if (msg.includes("500") || msg.includes("502") || msg.includes("503") ||
            msg.includes("internal server") || msg.includes("service unavailable")) {
          return true;
        }
        break;
      case "auth_error":
        if (msg.includes("401") || msg.includes("403") || msg.includes("unauthorized") ||
            msg.includes("forbidden") || msg.includes("invalid api key")) {
          return true;
        }
        break;
    }
  }

  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Completion execution ────────────────────────────────────

async function executeCompletion(
  config: AIServiceConfig,
  options: AICompletionOptions,
  costEstimator: CostEstimator,
): Promise<AICompletionResult> {
  const startTime = Date.now();

  // Resolve model
  const resolved = resolveModel(config, options.provider, options.model);

  // Enforce maxTokens limit
  let maxOutputTokens = options.maxTokens;
  if (config.limits?.maxTokensPerRequest) {
    if (maxOutputTokens) {
      maxOutputTokens = Math.min(maxOutputTokens, config.limits.maxTokensPerRequest);
    } else {
      maxOutputTokens = config.limits.maxTokensPerRequest;
    }
  }

  // Get provider language model
  const model = await getLanguageModel(config, resolved);

  // Choose between generateText and generateObject based on responseFormat
  if (options.responseFormat?.type === "json") {
    // Structured output with Zod schema validation
    const { generateObject } = await import("ai");
    const result = await generateObject({
      model,
      messages: options.messages,
      schema: options.responseFormat.schema,
      temperature: options.temperature ?? 0,
      maxOutputTokens,
      abortSignal: options.timeout ? AbortSignal.timeout(options.timeout) : undefined,
    });

    const duration = Date.now() - startTime;
    const inputTokens = result.usage?.inputTokens ?? 0;
    const outputTokens = result.usage?.outputTokens ?? 0;

    return {
      content: JSON.stringify(result.object),
      data: result.object,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        cost: costEstimator.estimateCost(resolved.modelId, inputTokens, outputTokens),
      },
      model: resolved.modelId,
      provider: resolved.provider,
      duration,
    };
  }

  // Text completion (with optional tool calling)
  const { generateText } = await import("ai");

  // Build tool definitions if provided
  // biome-ignore lint/suspicious/noExplicitAny: Vercel AI SDK tools type is complex
  let tools: Record<string, any> | undefined;
  if (options.tools && options.tools.length > 0) {
    const { tool: defineTool, jsonSchema } = await import("ai");
    tools = {};
    for (const t of options.tools) {
      tools[t.name] = defineTool({
        description: t.description,
        // Pass actual JSON Schema parameters from the tool definition
        inputSchema: jsonSchema(t.parameters),
      });
    }
  }

  const result = await generateText({
    model,
    messages: options.messages,
    temperature: options.temperature ?? 0,
    maxOutputTokens,
    tools,
    abortSignal: options.timeout ? AbortSignal.timeout(options.timeout) : undefined,
  });

  const duration = Date.now() - startTime;

  // Extract tool calls
  let toolCalls: AIToolCall[] | undefined;
  if (result.toolCalls && result.toolCalls.length > 0) {
    toolCalls = result.toolCalls.map((tc: { toolName: string; input: unknown }) => ({
      toolName: tc.toolName,
      args: tc.input as Record<string, unknown>,
    }));
  }

  const inputTokens = result.usage?.inputTokens ?? 0;
  const outputTokens = result.usage?.outputTokens ?? 0;

  return {
    content: result.text,
    toolCalls,
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      cost: costEstimator.estimateCost(resolved.modelId, inputTokens, outputTokens),
    },
    model: resolved.modelId,
    provider: resolved.provider,
    duration,
  };
}

// ── Streaming completion ─────────────────────────────────

/**
 * Execute a streaming completion request.
 * Returns an async iterable of text chunks using Vercel AI SDK's streamText.
 */
async function executeStream(
  config: AIServiceConfig,
  options: AICompletionOptions,
): Promise<AIStreamResult> {
  // Resolve tenant-specific config if tenantId is specified
  const effectiveConfig = options.tenantId
    ? resolveTenantConfig(config, options.tenantId)
    : config;

  // Apply model routing if taskType is specified and no explicit model
  let resolvedOptions = options;
  if (options.taskType && !options.model) {
    const route = resolveModelRoute(effectiveConfig.routing, options.taskType);
    if (route) {
      resolvedOptions = {
        ...options,
        model: route.model,
        provider: route.provider ?? options.provider,
      };
    }
  }

  // Resolve model
  const resolved = resolveModel(effectiveConfig, resolvedOptions.provider, resolvedOptions.model);

  // Enforce maxTokens limit
  let maxOutputTokens = resolvedOptions.maxTokens;
  if (effectiveConfig.limits?.maxTokensPerRequest) {
    if (maxOutputTokens) {
      maxOutputTokens = Math.min(maxOutputTokens, effectiveConfig.limits.maxTokensPerRequest);
    } else {
      maxOutputTokens = effectiveConfig.limits.maxTokensPerRequest;
    }
  }

  // Get provider language model
  const model = await getLanguageModel(effectiveConfig, resolved);

  const { streamText } = await import("ai");

  const result = streamText({
    model,
    messages: resolvedOptions.messages,
    temperature: resolvedOptions.temperature ?? 0,
    maxOutputTokens,
    abortSignal: resolvedOptions.timeout ? AbortSignal.timeout(resolvedOptions.timeout) : undefined,
  });

  return {
    textStream: result.textStream,
    model: resolved.modelId,
    provider: resolved.provider,
  };
}
