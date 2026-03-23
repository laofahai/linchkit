/**
 * AI Service Engine
 *
 * Thin wrapper over Vercel AI SDK providing:
 * 1. Model alias resolution (fast/standard/advanced → provider + model ID)
 * 2. Unified multi-provider interface
 * 3. Usage tracking and cost estimation
 * 4. Integration with ActionContext via ctx.ai
 *
 * See spec 36_ai_service.md for full design.
 */

import type {
  AICompletionOptions,
  AICompletionResult,
  AIProviderType,
  AIService,
  AIServiceConfig,
  AIToolCall,
} from "../types/ai";

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
 * Create an AIService instance.
 *
 * The service is optional — if no config is provided, calling complete()
 * will throw a clear error. The system works without AI.
 */
export function createAIService(config: AIServiceConfig): AIService {
  validateConfig(config);

  return {
    complete: (options) => executeCompletion(config, options),
  };
}

/**
 * Create a no-op AIService that throws on any call.
 * Used when AI is not configured — graceful degradation.
 */
export function createNoopAIService(): AIService {
  return {
    complete: () => {
      throw new Error("AI service is not configured. Add an 'ai' section to your LinchKit config.");
    },
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

// ── Completion execution ────────────────────────────────────

async function executeCompletion(
  config: AIServiceConfig,
  options: AICompletionOptions,
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

    return {
      content: JSON.stringify(result.object),
      data: result.object,
      usage: {
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
        totalTokens: (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
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

  return {
    content: result.text,
    toolCalls,
    usage: {
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
      totalTokens: (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
    },
    model: resolved.modelId,
    provider: resolved.provider,
    duration,
  };
}
