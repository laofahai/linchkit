import { describe, expect, it, beforeEach, mock } from "bun:test";
import {
  createAIService,
  defaultAIConfig,
  resolveModel,
  resolveModelRoute,
  resolveTenantConfig,
  CostEstimator,
  defaultCostEstimator,
  AIResponseCache,
} from "@linchkit/cap-ai-provider";
import { createNoopAIService } from "../src/ai/ai-service";
import type {
  AICacheConfig,
  AICompletionOptions,
  AICompletionResult,
  AIModelRoute,
  AIServiceConfig,
  AITaskType,
} from "../src/types/ai";

// ── Test configs ───────────────────────────────────────────

const testConfig: AIServiceConfig = {
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
    openai: {
      defaultModel: "gpt-4o",
      models: {
        fast: "gpt-4o-mini",
        standard: "gpt-4o",
        advanced: "o3",
      },
    },
  },
  limits: {
    maxTokensPerRequest: 8192,
    maxRequestsPerMinute: 60,
    maxCostPerDay: 10.0,
  },
};

// ── CostEstimator tests ──────────────────────────────────────

describe("CostEstimator", () => {
  it("estimates cost for known Anthropic models", () => {
    const estimator = new CostEstimator();

    // claude-sonnet: $3/M input, $15/M output
    const cost = estimator.estimateCost("claude-sonnet-4-20250514", 1000, 500);
    expect(cost).toBeDefined();
    // 1000 * 3/1M + 500 * 15/1M = 0.003 + 0.0075 = 0.0105
    expect(cost!).toBeCloseTo(0.0105, 6);
  });

  it("estimates cost for known OpenAI models", () => {
    const estimator = new CostEstimator();

    // gpt-4o: $2.5/M input, $10/M output
    const cost = estimator.estimateCost("gpt-4o", 2000, 1000);
    expect(cost).toBeDefined();
    // 2000 * 2.5/1M + 1000 * 10/1M = 0.005 + 0.01 = 0.015
    expect(cost!).toBeCloseTo(0.015, 6);
  });

  it("returns undefined for unknown models", () => {
    const estimator = new CostEstimator();
    const cost = estimator.estimateCost("totally-unknown-model", 1000, 500);
    expect(cost).toBeUndefined();
  });

  it("supports prefix matching for versioned model IDs", () => {
    const estimator = new CostEstimator();
    // 'gpt-4o-2024-05-01' should match 'gpt-4o' pricing
    const cost = estimator.estimateCost("gpt-4o-2024-05-01", 1000, 500);
    expect(cost).toBeDefined();
  });

  it("allows registering custom pricing", () => {
    const estimator = new CostEstimator();
    estimator.registerPricing("my-custom-model", {
      inputPerToken: 1 / 1_000_000,
      outputPerToken: 2 / 1_000_000,
    });

    const cost = estimator.estimateCost("my-custom-model", 1000, 500);
    expect(cost).toBeDefined();
    expect(cost!).toBeCloseTo(0.002, 6); // 1000 * 1/1M + 500 * 2/1M = 0.001 + 0.001
  });

  it("custom pricing overrides defaults", () => {
    const estimator = new CostEstimator({
      "gpt-4o": { inputPerToken: 0, outputPerToken: 0 },
    });
    const cost = estimator.estimateCost("gpt-4o", 1000, 500);
    expect(cost).toBe(0);
  });

  it("hasPricing returns true for known models", () => {
    const estimator = new CostEstimator();
    expect(estimator.hasPricing("claude-sonnet-4-20250514")).toBe(true);
    expect(estimator.hasPricing("gpt-4o")).toBe(true);
    expect(estimator.hasPricing("unknown-model")).toBe(false);
  });

  it("getPricing returns pricing object", () => {
    const estimator = new CostEstimator();
    const pricing = estimator.getPricing("claude-haiku-4-5-20251001");
    expect(pricing).toBeDefined();
    expect(pricing!.inputPerToken).toBeGreaterThan(0);
    expect(pricing!.outputPerToken).toBeGreaterThan(0);
  });

  it("estimates pre-cost for budget checks", () => {
    const estimator = new CostEstimator();
    const preCost = estimator.estimatePreCost("claude-sonnet-4-20250514", 5000, 2000);
    expect(preCost).toBeDefined();
    expect(preCost!).toBeGreaterThan(0);
  });

  it("defaultCostEstimator singleton works", () => {
    expect(defaultCostEstimator).toBeInstanceOf(CostEstimator);
    expect(defaultCostEstimator.hasPricing("gpt-4o")).toBe(true);
  });

  it("estimates cost for haiku model", () => {
    const estimator = new CostEstimator();
    // claude-haiku: $0.8/M input, $4/M output
    const cost = estimator.estimateCost("claude-haiku-4-5-20251001", 10000, 5000);
    expect(cost).toBeDefined();
    // 10000 * 0.8/1M + 5000 * 4/1M = 0.008 + 0.02 = 0.028
    expect(cost!).toBeCloseTo(0.028, 6);
  });

  it("estimates cost for opus model", () => {
    const estimator = new CostEstimator();
    // claude-opus: $15/M input, $75/M output
    const cost = estimator.estimateCost("claude-opus-4-20250514", 1000, 500);
    expect(cost).toBeDefined();
    // 1000 * 15/1M + 500 * 75/1M = 0.015 + 0.0375 = 0.0525
    expect(cost!).toBeCloseTo(0.0525, 6);
  });
});

// ── AIResponseCache tests ────────────────────────────────────

describe("AIResponseCache", () => {
  let cache: AIResponseCache;

  const cacheConfig: AICacheConfig = {
    enabled: true,
    maxEntries: 5,
    ttlMs: 5000,
  };

  const sampleOptions: AICompletionOptions = {
    messages: [{ role: "user", content: "What is 2+2?" }],
    temperature: 0,
  };

  const sampleResult: AICompletionResult = {
    content: "4",
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cost: 0.001 },
    model: "test-model",
    provider: "test",
    duration: 100,
  };

  beforeEach(() => {
    cache = new AIResponseCache(cacheConfig);
  });

  it("returns undefined on cache miss", () => {
    const result = cache.get(sampleOptions);
    expect(result).toBeUndefined();
  });

  it("returns cached result on cache hit", () => {
    cache.set(sampleOptions, sampleResult);
    const result = cache.get(sampleOptions);
    expect(result).toBeDefined();
    expect(result!.content).toBe("4");
    expect(result!.cached).toBe(true);
  });

  it("does not cache requests with tools", () => {
    const options: AICompletionOptions = {
      ...sampleOptions,
      tools: [{ name: "test", description: "test", parameters: {} }],
    };
    cache.set(options, sampleResult);
    const result = cache.get(options);
    expect(result).toBeUndefined();
  });

  it("does not cache requests with temperature > 0", () => {
    const options: AICompletionOptions = {
      ...sampleOptions,
      temperature: 0.7,
    };
    cache.set(options, sampleResult);
    const result = cache.get(options);
    expect(result).toBeUndefined();
  });

  it("respects cache: false opt-out", () => {
    const options: AICompletionOptions = {
      ...sampleOptions,
      cache: false,
    };
    cache.set(options, sampleResult);
    const result = cache.get(options);
    expect(result).toBeUndefined();
  });

  it("evicts LRU entries when at capacity", () => {
    // Fill cache to capacity
    for (let i = 0; i < 5; i++) {
      const opts: AICompletionOptions = {
        messages: [{ role: "user", content: `Question ${i}` }],
      };
      cache.set(opts, { ...sampleResult, content: `Answer ${i}` });
    }
    expect(cache.size).toBe(5);

    // Add one more — should evict the least recently used
    const newOpts: AICompletionOptions = {
      messages: [{ role: "user", content: "Question new" }],
    };
    cache.set(newOpts, { ...sampleResult, content: "Answer new" });
    expect(cache.size).toBe(5);

    // New entry should be cached
    const newResult = cache.get(newOpts);
    expect(newResult).toBeDefined();
    expect(newResult!.content).toBe("Answer new");
  });

  it("expires entries after TTL", async () => {
    // Use a very short TTL
    const shortCache = new AIResponseCache({ enabled: true, ttlMs: 50 });
    shortCache.set(sampleOptions, sampleResult);

    // Immediately available
    expect(shortCache.get(sampleOptions)).toBeDefined();

    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 100));

    // Should be expired
    expect(shortCache.get(sampleOptions)).toBeUndefined();
  });

  it("clears all entries", () => {
    cache.set(sampleOptions, sampleResult);
    expect(cache.size).toBe(1);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it("returns cache stats", () => {
    const stats = cache.stats();
    expect(stats.maxEntries).toBe(5);
    expect(stats.ttlMs).toBe(5000);
    expect(stats.size).toBe(0);
  });

  it("respects model filter", () => {
    const filteredCache = new AIResponseCache({
      enabled: true,
      modelFilter: ["fast"],
    });

    // fast model should be cached
    const fastOpts: AICompletionOptions = {
      ...sampleOptions,
      model: "fast",
    };
    filteredCache.set(fastOpts, sampleResult);
    expect(filteredCache.get(fastOpts)).toBeDefined();

    // standard model should NOT be cached
    const stdOpts: AICompletionOptions = {
      ...sampleOptions,
      model: "standard",
    };
    filteredCache.set(stdOpts, sampleResult);
    expect(filteredCache.get(stdOpts)).toBeUndefined();
  });

  it("differentiates cache keys by provider", () => {
    const opts1: AICompletionOptions = {
      ...sampleOptions,
      provider: "anthropic",
    };
    const opts2: AICompletionOptions = {
      ...sampleOptions,
      provider: "openai",
    };

    cache.set(opts1, { ...sampleResult, content: "anthropic answer" });
    cache.set(opts2, { ...sampleResult, content: "openai answer" });

    expect(cache.get(opts1)!.content).toBe("anthropic answer");
    expect(cache.get(opts2)!.content).toBe("openai answer");
  });

  it("differentiates cache keys by tenant", () => {
    const opts1: AICompletionOptions = {
      ...sampleOptions,
      tenantId: "tenant-a",
    };
    const opts2: AICompletionOptions = {
      ...sampleOptions,
      tenantId: "tenant-b",
    };

    cache.set(opts1, { ...sampleResult, content: "tenant-a answer" });
    cache.set(opts2, { ...sampleResult, content: "tenant-b answer" });

    expect(cache.get(opts1)!.content).toBe("tenant-a answer");
    expect(cache.get(opts2)!.content).toBe("tenant-b answer");
  });
});

// ── resolveModelRoute tests ──────────────────────────────────

describe("resolveModelRoute", () => {
  const routes: AIModelRoute[] = [
    { taskType: "classification", model: "fast" },
    { taskType: "generation", model: "standard", provider: "anthropic" },
    { taskType: "analysis", model: "advanced", provider: "openai" },
    { taskType: "summarization", model: "fast" },
    { taskType: "code", model: "standard" },
  ];

  it("returns matched route for classification", () => {
    const result = resolveModelRoute(routes, "classification");
    expect(result).toEqual({ model: "fast", provider: undefined });
  });

  it("returns matched route with provider override", () => {
    const result = resolveModelRoute(routes, "analysis");
    expect(result).toEqual({ model: "advanced", provider: "openai" });
  });

  it("returns undefined for unknown task type", () => {
    const result = resolveModelRoute(routes, "conversation");
    expect(result).toBeUndefined();
  });

  it("returns undefined when no routes configured", () => {
    const result = resolveModelRoute(undefined, "classification");
    expect(result).toBeUndefined();
  });

  it("returns undefined for empty routes array", () => {
    const result = resolveModelRoute([], "classification");
    expect(result).toBeUndefined();
  });

  it("returns route with generation task type", () => {
    const result = resolveModelRoute(routes, "generation");
    expect(result).toEqual({ model: "standard", provider: "anthropic" });
  });
});

// ── resolveTenantConfig tests ────────────────────────────────

describe("resolveTenantConfig", () => {
  const configWithTenants: AIServiceConfig = {
    ...testConfig,
    tenants: {
      "tenant-a": {
        providers: {
          anthropic: { apiKey: "tenant-a-key" },
        },
        limits: {
          maxTokensPerRequest: 4096,
          maxCostPerDay: 5.0,
        },
      },
      "tenant-b": {
        fallback: {
          providers: ["openai"],
        },
      },
    },
  };

  it("returns global config for unknown tenant", () => {
    const result = resolveTenantConfig(configWithTenants, "unknown-tenant");
    expect(result).toBe(configWithTenants);
  });

  it("merges tenant provider overrides (BYOK)", () => {
    const result = resolveTenantConfig(configWithTenants, "tenant-a");
    expect(result.providers.anthropic.apiKey).toBe("tenant-a-key");
    // Other provider fields should remain from global
    expect(result.providers.anthropic.defaultModel).toBe("claude-sonnet-4-20250514");
  });

  it("overrides limits for tenant", () => {
    const result = resolveTenantConfig(configWithTenants, "tenant-a");
    expect(result.limits?.maxTokensPerRequest).toBe(4096);
    expect(result.limits?.maxCostPerDay).toBe(5.0);
  });

  it("preserves global providers not overridden by tenant", () => {
    const result = resolveTenantConfig(configWithTenants, "tenant-a");
    // OpenAI provider should be unchanged
    expect(result.providers.openai.defaultModel).toBe("gpt-4o");
  });

  it("overrides fallback config for tenant", () => {
    const result = resolveTenantConfig(configWithTenants, "tenant-b");
    expect(result.fallback).toEqual({ providers: ["openai"] });
  });

  it("returns global config when no tenants defined", () => {
    const result = resolveTenantConfig(testConfig, "any-tenant");
    expect(result).toBe(testConfig);
  });
});

// ── AIService with routing integration ──────────────────────

describe("createAIService with routing config", () => {
  it("creates service with routing config without error", () => {
    const config: AIServiceConfig = {
      ...testConfig,
      routing: [
        { taskType: "classification", model: "fast" },
        { taskType: "analysis", model: "advanced" },
      ],
    };
    expect(() => createAIService(config)).not.toThrow();
  });

  it("creates service with cache config without error", () => {
    const config: AIServiceConfig = {
      ...testConfig,
      cache: { enabled: true, maxEntries: 100, ttlMs: 60000 },
    };
    expect(() => createAIService(config)).not.toThrow();
  });

  it("creates service with fallback config without error", () => {
    const config: AIServiceConfig = {
      ...testConfig,
      fallback: {
        providers: ["openai"],
        retriesPerProvider: 2,
        retryDelay: 500,
      },
    };
    expect(() => createAIService(config)).not.toThrow();
  });

  it("creates service with full config (routing + cache + fallback + tenants)", () => {
    const config: AIServiceConfig = {
      ...testConfig,
      routing: [
        { taskType: "classification", model: "fast" },
      ],
      cache: { enabled: true },
      fallback: { providers: ["openai"] },
      tenants: {
        "t1": {
          providers: { anthropic: { apiKey: "tenant-key" } },
        },
      },
    };
    expect(() => createAIService(config)).not.toThrow();
  });
});

// ── Existing tests preserved ─────────────────────────────────

describe("resolveModel", () => {
  it("resolves to default provider + default model when no args", () => {
    const result = resolveModel(testConfig);
    expect(result).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
    });
  });

  it("resolves 'fast' alias to provider-specific model", () => {
    const result = resolveModel(testConfig, undefined, "fast");
    expect(result).toEqual({
      provider: "anthropic",
      modelId: "claude-haiku-4-5-20251001",
    });
  });

  it("resolves 'standard' alias", () => {
    const result = resolveModel(testConfig, undefined, "standard");
    expect(result).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
    });
  });

  it("resolves 'advanced' alias", () => {
    const result = resolveModel(testConfig, undefined, "advanced");
    expect(result).toEqual({
      provider: "anthropic",
      modelId: "claude-opus-4-20250514",
    });
  });

  it("resolves alias with explicit provider", () => {
    const result = resolveModel(testConfig, "openai", "fast");
    expect(result).toEqual({
      provider: "openai",
      modelId: "gpt-4o-mini",
    });
  });

  it("treats unknown alias as literal model ID", () => {
    const result = resolveModel(testConfig, "openai", "gpt-4-turbo");
    expect(result).toEqual({
      provider: "openai",
      modelId: "gpt-4-turbo",
    });
  });

  it("uses default model when provider specified but no model", () => {
    const result = resolveModel(testConfig, "openai");
    expect(result).toEqual({
      provider: "openai",
      modelId: "gpt-4o",
    });
  });

  it("throws on unknown provider", () => {
    expect(() => resolveModel(testConfig, "google", "fast")).toThrow(
      'Unknown AI provider: "google"',
    );
  });
});

describe("createNoopAIService", () => {
  it("throws on complete() with a helpful message", async () => {
    const noop = createNoopAIService();
    expect(() => noop.complete({ messages: [{ role: "user", content: "hello" }] })).toThrow(
      "AI service is not configured",
    );
  });
});

describe("defaultAIConfig", () => {
  it("has anthropic as default provider", () => {
    expect(defaultAIConfig.defaultProvider).toBe("anthropic");
  });

  it("has standard model aliases defined", () => {
    const models = defaultAIConfig.providers.anthropic.models;
    expect(models).toBeDefined();
    expect(models?.fast).toBeDefined();
    expect(models?.standard).toBeDefined();
    expect(models?.advanced).toBeDefined();
  });

  it("passes config validation", () => {
    expect(() => createAIService(defaultAIConfig)).not.toThrow();
  });
});

// ── Fallback error classification ────────────────────────────

describe("fallback error classification", () => {
  // These test the shouldFallback logic indirectly through config validation.
  // Direct fallback execution requires real API calls, tested in e2e.

  it("fallback config accepts valid error types", () => {
    const config: AIServiceConfig = {
      ...testConfig,
      fallback: {
        providers: ["openai"],
        onErrors: ["timeout", "rate_limit", "server_error", "auth_error"],
      },
    };
    expect(() => createAIService(config)).not.toThrow();
  });

  it("fallback config with retry settings", () => {
    const config: AIServiceConfig = {
      ...testConfig,
      fallback: {
        providers: ["openai"],
        retriesPerProvider: 3,
        retryDelay: 2000,
      },
    };
    expect(() => createAIService(config)).not.toThrow();
  });
});

// ── Type-level checks ────────────────────────────────────────

describe("AICompletionOptions new fields", () => {
  it("accepts taskType field", () => {
    const options: AICompletionOptions = {
      messages: [{ role: "user", content: "classify this" }],
      taskType: "classification",
    };
    expect(options.taskType).toBe("classification");
  });

  it("accepts tenantId field", () => {
    const options: AICompletionOptions = {
      messages: [{ role: "user", content: "hello" }],
      tenantId: "tenant-x",
    };
    expect(options.tenantId).toBe("tenant-x");
  });

  it("accepts cache field", () => {
    const options: AICompletionOptions = {
      messages: [{ role: "user", content: "hello" }],
      cache: false,
    };
    expect(options.cache).toBe(false);
  });
});

describe("AICompletionResult new fields", () => {
  it("includes cached flag in cached responses", () => {
    const result: AICompletionResult = {
      content: "test",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      model: "test",
      provider: "test",
      duration: 100,
      cached: true,
    };
    expect(result.cached).toBe(true);
  });

  it("includes fallbackUsed when fallback occurred", () => {
    const result: AICompletionResult = {
      content: "test",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      model: "test",
      provider: "openai",
      duration: 100,
      fallbackUsed: "anthropic",
    };
    expect(result.fallbackUsed).toBe("anthropic");
  });
});

// ── AITaskType coverage ──────────────────────────────────────

describe("AITaskType values", () => {
  const allTypes: AITaskType[] = [
    "classification",
    "extraction",
    "generation",
    "summarization",
    "analysis",
    "conversation",
    "code",
  ];

  for (const taskType of allTypes) {
    it(`accepts task type: ${taskType}`, () => {
      const options: AICompletionOptions = {
        messages: [{ role: "user", content: "test" }],
        taskType,
      };
      expect(options.taskType).toBe(taskType);
    });
  }
});
