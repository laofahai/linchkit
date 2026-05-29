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
  AICompletionOptions,
  AICompletionResult,
  AIModelRoute,
  AIProviderConfig,
  AIProviderType,
  AIService,
  AIServiceConfig,
  AIStreamResult,
  AITaskType,
  AITenantConfig,
  AIToolCall,
  AITraceSamplingConfig,
} from "@linchkit/core";
import {
  fallbackTraceId,
  logTracingError,
  openParentTrace,
  type ParentTraceHandle,
  recordGeneration,
  recordSuccess,
} from "./ai-tracing";
import { CostEstimator } from "./cost-estimator";
import { AIResponseCache } from "./response-cache";

/**
 * The subset of the Vercel AI SDK `streamText` result the streaming path reads
 * for accurate post-drain accounting. Each accessor is a `PromiseLike` that the
 * SDK resolves only AFTER the stream fully drains (it "automatically consumes
 * the stream"), so we MUST await them only once the consumer has finished
 * iterating `textStream` — never before, or we would consume the stream out
 * from under the consumer.
 *
 * Mirrors `StreamTextResult` (ai@6) `usage` / `totalUsage` / `text` /
 * `finishReason` accessors; declared structurally so tests can inject a fake
 * without depending on the SDK's generic result type.
 */
export interface StreamTextLike {
  /** Text delta stream the consumer iterates. */
  readonly textStream: AsyncIterable<string>;
  /**
   * Total token usage across all steps, resolved after drain. `totalUsage`
   * sums multi-step usage; fields may be `undefined` when a provider omits
   * them (coerced to 0 at the call site, mirroring the completion path).
   */
  readonly totalUsage: PromiseLike<{
    inputTokens?: number;
    outputTokens?: number;
  }>;
  /** Full generated text, resolved after drain. */
  readonly text: PromiseLike<string>;
}

/**
 * Internal generation runners — the seam between the service and the Vercel AI
 * SDK. Defaults dynamically import `ai`; tests inject fakes so `complete()`
 * runs end-to-end (and through the tracing instrumentation) without a network
 * call. Not part of the public API.
 *
 * biome-ignore lint/suspicious/noExplicitAny: Vercel AI SDK result types are generic.
 */
type AnyGenerateResult = any;

/** Injectable runners (test seam). All optional — real paths used by default. */
export interface AIServiceInternals {
  /** Resolve a provider LanguageModel. Defaults to the lazy SDK loader. */
  // biome-ignore lint/suspicious/noExplicitAny: Vercel AI SDK LanguageModel is generic.
  getModel?: (config: AIServiceConfig, resolved: ResolvedModel) => Promise<any>;
  /** Run a structured (JSON) generation. Defaults to `ai.generateObject`. */
  runGenerateObject?: (args: AnyGenerateResult) => Promise<AnyGenerateResult>;
  /** Run a text generation. Defaults to `ai.generateText`. */
  runGenerateText?: (args: AnyGenerateResult) => Promise<AnyGenerateResult>;
  /**
   * Run a streaming text generation. Defaults to `ai.streamText`. Returns a
   * result exposing the consumer's `textStream` plus post-drain `totalUsage` /
   * `text` accessors (see {@link StreamTextLike}). SYNCHRONOUS like the SDK's
   * `streamText` — it returns a result object immediately and streams lazily.
   */
  runStreamText?: (args: AnyGenerateResult) => StreamTextLike;
  /**
   * Trace sampling config. Applied at every span/record call. Defaults to
   * recording everything; set `{ rate: 0 }` to disable tracing entirely
   * without changing the active sink.
   */
  sampling?: AITraceSamplingConfig;
}

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
export function createAIService(
  config: AIServiceConfig,
  internals?: AIServiceInternals,
): AIService {
  validateConfig(config);

  const costEstimator = new CostEstimator();
  const cache = config.cache?.enabled ? new AIResponseCache(config.cache) : undefined;

  return {
    configured: true,
    defaultProvider: config.defaultProvider,
    providerNames: Object.keys(config.providers),
    complete: (options) => executeWithFallback(config, options, costEstimator, cache, internals),
    completeStream: (options) => executeStream(config, options, costEstimator, internals),
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

function mergeTenantConfig(global: AIServiceConfig, tenant: AITenantConfig): AIServiceConfig {
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
  internals?: AIServiceInternals,
): Promise<AICompletionResult> {
  // Resolve tenant-specific config if tenantId is specified
  const effectiveConfig = options.tenantId ? resolveTenantConfig(config, options.tenantId) : config;

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

  // Open the parent trace once — it spans every retry + fallback attempt so
  // a single trace shows the full resolution path. Non-throwing. The parent
  // resolves the sampling decision ONCE; thread it into every child generation
  // so a fractional rate never rolls independently (which would orphan a
  // sampled-in generation under a sampled-out parent, or vice-versa).
  const parent = openParentTrace(resolvedOptions.trace, { sampling: internals?.sampling });
  // Thread the resolved parent trace id into child generations so retries land
  // under one trace even when the caller did not pre-allocate a trace id.
  const tracedOptions: AICompletionOptions = {
    ...resolvedOptions,
    trace: { ...resolvedOptions.trace, traceId: parent.traceId },
  };

  const fallback = effectiveConfig.fallback;
  if (!fallback || fallback.providers.length === 0) {
    // No fallback chain — execute directly
    try {
      const result = await executeCompletion(effectiveConfig, tracedOptions, costEstimator, {
        internals,
        sampled: parent.sampled,
      });
      cache?.set(resolvedOptions, result);
      parent.end("ok");
      return result;
    } catch (error) {
      parent.end("error");
      throw error;
    }
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
        const attemptOptions = { ...tracedOptions, provider: providerName };
        const result = await executeCompletion(effectiveConfig, attemptOptions, costEstimator, {
          internals,
          sampled: parent.sampled,
          // Stamp the originally-failed provider so a fallback-served success
          // records `fallbackUsed` on its generation (the trace records BEFORE
          // we set result.fallbackUsed below).
          fallbackUsed: failedPrimary,
        });

        // Mark if fallback was used
        if (failedPrimary) {
          result.fallbackUsed = failedPrimary;
        }

        cache?.set(resolvedOptions, result);
        parent.end("ok");
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Check if this error type should trigger fallback
        if (fallback.onErrors && !shouldFallback(lastError, fallback.onErrors)) {
          parent.end("error");
          throw lastError;
        }

        if (!failedPrimary) failedPrimary = providerName;

        // Delay between retries (not before the very first attempt)
        if (
          attempt < retriesPerProvider - 1 ||
          providerChain.indexOf(providerName) < providerChain.length - 1
        ) {
          await sleep(retryDelay);
        }
      }
    }
  }

  // All providers exhausted
  parent.end("error");
  throw new Error(`All AI providers failed. Last error: ${lastError?.message ?? "unknown"}`);
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
        if (
          msg.includes("500") ||
          msg.includes("502") ||
          msg.includes("503") ||
          msg.includes("internal server") ||
          msg.includes("service unavailable")
        ) {
          return true;
        }
        break;
      case "auth_error":
        if (
          msg.includes("401") ||
          msg.includes("403") ||
          msg.includes("unauthorized") ||
          msg.includes("forbidden") ||
          msg.includes("invalid api key")
        ) {
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

/** Tracing metadata threaded down from `executeWithFallback` per attempt. */
interface ExecuteCompletionTrace {
  /** Injectable SDK runners + sampling config (test seam). */
  internals?: AIServiceInternals;
  /** Parent-trace sampling decision — rolled once, reused for every attempt. */
  sampled: boolean;
  /** Provider that originally failed when this attempt is a fallback. */
  fallbackUsed?: string;
}

async function executeCompletion(
  config: AIServiceConfig,
  options: AICompletionOptions,
  costEstimator: CostEstimator,
  traceMeta: ExecuteCompletionTrace,
): Promise<AICompletionResult> {
  const internals = traceMeta.internals;
  const startTime = Date.now();
  const trace = options.trace;
  // Parent trace id is threaded in by executeWithFallback; standalone callers
  // (none in-repo) get a fresh id via the sink. recordSuccess/recordGeneration
  // resolve it from the context, so pass the context straight through.
  const responseFormat: "text" | "json" = options.responseFormat?.type === "json" ? "json" : "text";

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

  // Fall back to a FRESH unique id per call (never the model name) so untraced
  // calls stay isolated instead of all collapsing under one static traceId.
  const traceId = trace?.traceId ?? fallbackTraceId();

  try {
    // Get provider language model
    const model = await (internals?.getModel
      ? internals.getModel(config, resolved)
      : getLanguageModel(config, resolved));

    // Choose between generateText and generateObject based on responseFormat
    if (options.responseFormat?.type === "json") {
      // Structured output with Zod schema validation
      const runObject = internals?.runGenerateObject ?? (await import("ai")).generateObject;
      const result = await runObject({
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

      const completion: AICompletionResult = {
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

      // Record the generation (non-throwing). startedAt/endedAt are wall-clock
      // epoch ms so a later span exporter can place it on a timeline.
      recordSuccess({
        result: completion,
        context: trace,
        traceId,
        messages: options.messages,
        startedAt: startTime,
        endedAt: startTime + duration,
        temperature: options.temperature,
        responseFormat,
        sampling: internals?.sampling,
        forcedSampled: traceMeta.sampled,
        fallbackUsed: traceMeta.fallbackUsed,
      });

      return completion;
    }

    // Text completion (with optional tool calling)
    const runText = internals?.runGenerateText ?? (await import("ai")).generateText;

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

    const result = await runText({
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

    const completion: AICompletionResult = {
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

    recordSuccess({
      result: completion,
      context: trace,
      traceId,
      messages: options.messages,
      startedAt: startTime,
      endedAt: startTime + duration,
      temperature: options.temperature,
      responseFormat,
      sampling: internals?.sampling,
      forcedSampled: traceMeta.sampled,
      fallbackUsed: traceMeta.fallbackUsed,
    });

    return completion;
  } catch (error) {
    // Record the failed generation (non-throwing) before re-throwing so the
    // fallback chain still sees the error. status: "error" with the message.
    const endTime = Date.now();
    recordGeneration({
      traceId,
      context: trace,
      model: resolved.modelId,
      provider: resolved.provider,
      messages: options.messages,
      completion: "",
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: endTime - startTime,
      temperature: options.temperature,
      responseFormat,
      status: "error",
      error: error instanceof Error ? error.message : String(error),
      startedAt: startTime,
      endedAt: endTime,
      sampling: internals?.sampling,
      forcedSampled: traceMeta.sampled,
      fallbackUsed: traceMeta.fallbackUsed,
    });
    throw error;
  }
}

// ── Streaming completion ─────────────────────────────────

/**
 * Execute a streaming completion request.
 *
 * Returns an async iterable of text chunks backed by the Vercel AI SDK's
 * `streamText`. Token usage, cost, and the full completion text are only known
 * AFTER the stream fully drains (the SDK's `totalUsage` / `text` accessors are
 * `PromiseLike`s that "automatically consume the stream" and resolve only once
 * iteration finishes — see {@link StreamTextLike}). So we do NOT record at
 * stream open; instead we wrap `textStream` and record exactly one ACCURATE
 * generation when the consumer finishes draining it (`partial: false`,
 * `status: "ok"`, correct tokens/cost/completion/latency). If the consumer
 * aborts or the stream errors before draining, we record a single
 * `partial: true` / `status: "error"` record instead. Either way the recording
 * is strictly non-throwing and never alters the consumer's stream or timing.
 */
async function executeStream(
  config: AIServiceConfig,
  options: AICompletionOptions,
  costEstimator: CostEstimator,
  internals?: AIServiceInternals,
): Promise<AIStreamResult> {
  const startTime = Date.now();

  // Resolve tenant-specific config if tenantId is specified
  const effectiveConfig = options.tenantId ? resolveTenantConfig(config, options.tenantId) : config;

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
  const model = await (internals?.getModel
    ? internals.getModel(effectiveConfig, resolved)
    : getLanguageModel(effectiveConfig, resolved));

  // Open the parent trace ONCE (mirrors the completion path) so the stream's
  // generation lands under a parent and the trace's token/cost rollup is
  // correct. The sampling decision is resolved here and threaded into the
  // child generation via `forcedSampled` so a fractional rate rolls once.
  // Non-throwing — an inert handle is returned on failure.
  const parent = openParentTrace(resolvedOptions.trace, { sampling: internals?.sampling });

  try {
    // Use the injectable runner (test seam); default to the SDK's `streamText`,
    // which is SYNCHRONOUS — it returns a result object immediately and streams
    // lazily as the consumer iterates `textStream`.
    let result: StreamTextLike;
    if (internals?.runStreamText) {
      result = internals.runStreamText({
        model,
        messages: resolvedOptions.messages,
        temperature: resolvedOptions.temperature ?? 0,
        maxOutputTokens,
        abortSignal: resolvedOptions.timeout
          ? AbortSignal.timeout(resolvedOptions.timeout)
          : undefined,
      });
    } else {
      const { streamText } = await import("ai");
      result = streamText({
        model,
        messages: resolvedOptions.messages,
        temperature: resolvedOptions.temperature ?? 0,
        maxOutputTokens,
        abortSignal: resolvedOptions.timeout
          ? AbortSignal.timeout(resolvedOptions.timeout)
          : undefined,
      }) as StreamTextLike;
    }

    return {
      // Wrap the SDK stream so accounting is recorded once iteration finishes —
      // accurate on a clean drain, partial/error on an abort. The wrapper yields
      // the SAME chunks in the SAME order, so the consumer sees identical output.
      textStream: instrumentStreamText({
        result,
        costEstimator,
        resolved,
        options: resolvedOptions,
        startTime,
        parent,
        sampling: internals?.sampling,
      }),
      model: resolved.modelId,
      provider: resolved.provider,
    };
  } catch (error) {
    // Acquiring the stream failed AFTER the parent trace was opened (the `ai`
    // import rejected, or `streamText` / the injected runner threw
    // synchronously). The consumer never receives a stream to drain, so
    // `instrumentStreamText`'s own finalizer can never run — finalize the parent
    // here so the opened trace is never left without a matching end, then
    // re-throw to the caller. `parent.end` is non-throwing.
    parent.end("error");
    throw error;
  }
}

/** Inputs for {@link instrumentStreamText}. */
interface InstrumentStreamInput {
  /** The SDK (or fake) stream result exposing `textStream` + post-drain usage. */
  readonly result: StreamTextLike;
  readonly costEstimator: CostEstimator;
  readonly resolved: ResolvedModel;
  readonly options: AICompletionOptions;
  /** Stream-open wall-clock epoch ms (latency baseline). */
  readonly startTime: number;
  /**
   * Parent trace handle (from `openParentTrace`). Carries the trace id +
   * sampling decision threaded into the child generation, plus the non-throwing
   * `end()` finalizer called once the stream finishes (success or error).
   */
  readonly parent: ParentTraceHandle;
  /** Sampling config (only consulted for the standalone fallback path). */
  readonly sampling?: AITraceSamplingConfig;
}

/**
 * Wrap an SDK text stream so token-accurate accounting is recorded exactly
 * once when the stream finishes.
 *
 * On a clean drain: await `totalUsage` + `text` (resolved only after the stream
 * is fully consumed), compute cost with the SAME estimator the completion path
 * uses, and record ONE accurate `partial: false` / `status: "ok"` generation.
 *
 * On abort / error before draining: record ONE `partial: true` /
 * `status: "error"` generation, then re-throw so the consumer's iteration still
 * surfaces the error (we instrument, we never swallow the stream's own error).
 *
 * The recording itself is wrapped in {@link recordStreamFinish} so a tracing
 * failure is swallowed and never affects the consumer's stream.
 */
async function* instrumentStreamText(input: InstrumentStreamInput): AsyncGenerator<string> {
  const { result } = input;
  let fullText = "";
  // Tracks whether the clean-drain or error path already finalized the trace, so
  // the `finally` below only handles the third case: a consumer that abandons
  // the stream early (`break`/`return` without an error).
  let settled = false;
  try {
    for await (const chunk of result.textStream) {
      fullText += chunk;
      yield chunk;
    }
    // Clean drain — the usage / text accessors are now resolved. Capture the
    // drain-completion time HERE (not after awaiting the post-drain
    // usage/text promises in the recorder) so `latencyMs` reflects how long the
    // stream actually took, not extra time the SDK spends resolving accounting.
    const endedAt = Date.now();
    settled = true;
    recordStreamFinish({ input, outcome: { kind: "done", streamedText: fullText, endedAt } });
  } catch (error) {
    // The stream itself failed (or the consumer's `break`/`return` triggered an
    // AbortSignal that the SDK surfaced as a throw). Record a partial/error
    // generation, then re-throw the ORIGINAL error so the consumer still sees
    // it — tracing must not swallow the stream's own failure.
    settled = true;
    recordStreamFinish({
      input,
      outcome: { kind: "error", error, partialText: fullText },
    });
    throw error;
  } finally {
    // The consumer abandoned the stream early (`break`/`return` with no error),
    // so neither the clean-drain nor the error path ran. Do NOT record a
    // generation: `totalUsage` / `text` never resolve on a non-drained stream,
    // so awaiting them could hang the fire-and-forget recorder forever. But DO
    // finalize the parent trace so a `startTrace` is never left without a
    // matching `endTrace` (an open-trace leak). `parent.end` is non-throwing.
    if (!settled) {
      input.parent.end("ok");
    }
  }
}

/** Outcome of draining a stream, passed to {@link recordStreamFinish}. */
type StreamFinishOutcome =
  | { kind: "done"; streamedText: string; endedAt: number }
  | { kind: "error"; error: unknown; partialText: string };

/**
 * Record the final generation for a finished stream. STRICTLY non-throwing —
 * any failure (including awaiting the SDK usage/text promises) is swallowed and
 * logged once via the tracing wrapper, so a tracing failure can NEVER break or
 * alter the consumer's stream. Runs AFTER the consumer has finished iterating,
 * so awaiting `totalUsage` / `text` here never consumes the stream out from
 * under the consumer.
 */
function recordStreamFinish(args: {
  input: InstrumentStreamInput;
  outcome: StreamFinishOutcome;
}): void {
  const { input, outcome } = args;
  const { result, costEstimator, resolved, options, startTime, parent, sampling } = input;

  if (outcome.kind === "error") {
    // Abort / stream error before a clean drain — usage is unknown, so record a
    // single partial/error generation with zero tokens (mirrors the completion
    // error path). Synchronous so it cannot stall or throw asynchronously.
    const endedAt = Date.now();
    recordGeneration({
      traceId: parent.traceId,
      context: options.trace,
      model: resolved.modelId,
      provider: resolved.provider,
      messages: options.messages,
      completion: outcome.partialText,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: endedAt - startTime,
      temperature: options.temperature,
      responseFormat: "text",
      partial: true,
      status: "error",
      error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
      startedAt: startTime,
      endedAt,
      sampling,
      forcedSampled: parent.sampled,
    });
    // Finalize the parent trace as errored (non-throwing).
    parent.end("error");
    return;
  }

  // Clean drain — await the post-drain usage/text accessors, compute cost, and
  // record ONE accurate generation. The await is wrapped so a rejected/throwing
  // accessor is swallowed (the consumer's stream has already completed). Fire
  // and forget: nothing awaits this and the stream's output is already done.
  void (async () => {
    try {
      // The stream drained cleanly, so this is a SUCCESS regardless of whether
      // the usage accessor is available. Isolate the usage await so a rejected /
      // undefined `totalUsage` falls back to 0 tokens instead of skipping the
      // record entirely and marking the parent errored (some providers omit
      // usage on streams). `usage?.` guards a null/undefined resolution too.
      let inputTokens = 0;
      let outputTokens = 0;
      try {
        const usage = await result.totalUsage;
        inputTokens = usage?.inputTokens ?? 0;
        outputTokens = usage?.outputTokens ?? 0;
      } catch {
        // totalUsage unavailable/rejected — keep 0 tokens; still record below.
      }
      // Prefer the SDK's authoritative final text; fall back to the text we
      // accumulated from the chunks if the accessor is unavailable.
      let completion = outcome.streamedText;
      try {
        completion = await result.text;
      } catch {
        // Keep the accumulated text — recordGeneration below is still accurate
        // on tokens/cost even if the SDK text accessor rejects.
      }
      // Use the drain-completion time captured in `instrumentStreamText` so
      // latency excludes the time spent awaiting the post-drain usage/text
      // promises above.
      const endedAt = outcome.endedAt;
      recordGeneration({
        traceId: parent.traceId,
        context: options.trace,
        model: resolved.modelId,
        provider: resolved.provider,
        messages: options.messages,
        completion,
        inputTokens,
        outputTokens,
        cost: costEstimator.estimateCost(resolved.modelId, inputTokens, outputTokens),
        latencyMs: endedAt - startTime,
        temperature: options.temperature,
        responseFormat: "text",
        partial: false,
        status: "ok",
        startedAt: startTime,
        endedAt,
        sampling,
        forcedSampled: parent.sampled,
      });
      // Finalize the parent trace as ok (non-throwing).
      parent.end("ok");
    } catch (err) {
      // Awaiting usage/text rejected (or recordGeneration's own guard somehow
      // escaped). Swallow — a tracing failure must never escape into the
      // consumer's already-completed stream. Log once via the tracing latch.
      logTracingError("stream-finish", err);
      // Still finalize the parent so the trace does not leak open.
      parent.end("error");
    }
  })();
}
