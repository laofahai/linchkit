/**
 * AI Service — Core Interface + Noop + Config Utilities
 *
 * Core keeps:
 * 1. AIService interface (types/ai.ts)
 * 2. createNoopAIService — safe no-op for zero-AI installs
 * 3. Config helpers — resolveModel, resolveModelRoute, resolveTenantConfig
 * 4. Default config shape — defaultAIConfig
 *
 * What moved out:
 * - Vercel AI SDK provider instantiation (getLanguageModel) → cap-ai-provider
 * - executeCompletion / executeStream → cap-ai-provider
 * - createAIService (SDK-backed factory) → cap-ai-provider
 *
 * See spec 36_ai_service.md and spec 56_core_slimming.md.
 */

import type {
  AICompletionOptions,
  AIModelRoute,
  AIProviderConfig,
  AIService,
  AIServiceConfig,
  AITaskType,
  AITenantConfig,
} from "../types/ai";

// ── Migration stub ────────────────────────────────────────────

/**
 * @deprecated Moved to @linchkit/cap-ai-provider.
 *
 * Returns a Vercel AI SDK LanguageModel for the given provider/model alias.
 * This function is no longer implemented in core — install cap-ai-provider.
 */
export async function resolveLanguageModel(
  _config: AIServiceConfig,
  _modelAlias?: string,
  _providerName?: string,
  // biome-ignore lint/suspicious/noExplicitAny: LanguageModel type lives in @linchkit/cap-ai-provider
): Promise<any> {
  throw new Error(
    "resolveLanguageModel has been extracted to @linchkit/cap-ai-provider. " +
      "Import it from that package instead.",
  );
}

// ── Default configuration ────────────────────────────────────

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

// ── No-op service ────────────────────────────────────────────

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
      throw new Error(
        "AI service is not configured. Add an 'ai' section to your LinchKit config.",
      );
    },
  };
}

// ── Stub factory (migration shim) ────────────────────────────

/**
 * @deprecated Use createAIService from @linchkit/cap-ai-provider instead.
 *
 * The SDK-backed AIService implementation has been extracted to cap-ai-provider
 * as part of core slimming (Spec 56). This stub validates config and returns a
 * service whose complete() throws a migration error at runtime.
 *
 * To restore full AI functionality:
 *   1. Install @linchkit/cap-ai-provider
 *   2. Import createAIService from that package
 */
export function createAIService(config: AIServiceConfig): AIService {
  validateConfig(config);

  return {
    configured: true,
    defaultProvider: config.defaultProvider,
    providerNames: Object.keys(config.providers),
    complete: (_options: AICompletionOptions) => {
      throw new Error(
        "AI provider implementation not available. " +
          "Install @linchkit/cap-ai-provider and import createAIService from there.",
      );
    },
  };
}

// ── Config validation ─────────────────────────────────────────

/** Infer provider type from well-known provider names. */
function inferProviderType(name: string): "anthropic" | "openai" | undefined {
  if (name === "anthropic") return "anthropic";
  if (name === "openai") return "openai";
  return undefined;
}

export function validateConfig(config: AIServiceConfig): void {
  if (!config.defaultProvider) {
    throw new Error("AIServiceConfig.defaultProvider is required");
  }
  if (!config.providers || Object.keys(config.providers).length === 0) {
    throw new Error("AIServiceConfig.providers must have at least one provider");
  }
  if (!config.providers[config.defaultProvider]) {
    throw new Error(
      `Default provider "${config.defaultProvider}" is not defined in providers`,
    );
  }
  for (const [name, provider] of Object.entries(config.providers)) {
    if (!provider.defaultModel) {
      throw new Error(`Provider "${name}" must have a defaultModel`);
    }
    const resolvedType = (provider as AIProviderConfig).type ?? inferProviderType(name);
    if (!resolvedType) {
      throw new Error(
        `Provider "${name}" must have an explicit 'type' field ("anthropic" | "openai")`,
      );
    }
    if (!inferProviderType(name) && !(provider as AIProviderConfig).endpoint) {
      throw new Error(`Provider "${name}" requires an 'endpoint' field`);
    }
  }
}

// ── Model resolution ──────────────────────────────────────────

interface ResolvedModel {
  provider: string;
  modelId: string;
}

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

  if (providerConfig.models?.[modelAlias]) {
    return { provider, modelId: providerConfig.models[modelAlias] };
  }

  return { provider, modelId: modelAlias };
}

// ── Model routing ─────────────────────────────────────────────

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

// ── Tenant config resolution ──────────────────────────────────

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
  const mergedProviders = { ...global.providers };
  if (tenant.providers) {
    for (const [name, override] of Object.entries(tenant.providers)) {
      if (mergedProviders[name]) {
        mergedProviders[name] = {
          ...mergedProviders[name],
          ...override,
        } as AIProviderConfig;
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
