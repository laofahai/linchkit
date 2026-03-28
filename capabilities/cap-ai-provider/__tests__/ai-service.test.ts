/**
 * Tests for createAIService factory (cap-ai-provider)
 *
 * Tests pure logic (config validation, model resolution, tenant config,
 * fallback chain wiring) WITHOUT making real API calls.
 * The Vercel AI SDK generateText/streamText functions are not invoked here.
 *
 * Covers:
 * - createAIService validates config and returns configured service
 * - resolveModel: default, alias, literal model ID
 * - resolveModelRoute: task-type routing rules
 * - resolveTenantConfig: global merge with tenant overrides
 * - defaultAIConfig structure
 */

import { describe, expect, it } from "bun:test";
import {
  createAIService,
  defaultAIConfig,
  resolveModel,
  resolveModelRoute,
  resolveTenantConfig,
} from "../src/ai-service";
import type { AIServiceConfig } from "@linchkit/core";

// ── Minimal valid config ───────────────────────────────────────

const minimalConfig: AIServiceConfig = {
  defaultProvider: "anthropic",
  providers: {
    anthropic: {
      defaultModel: "claude-sonnet-4-20250514",
    },
  },
};

// ── createAIService ────────────────────────────────────────────

describe("createAIService", () => {
  it("returns a configured AIService object", () => {
    const service = createAIService(minimalConfig);

    expect(service).toBeDefined();
    expect(service.configured).toBe(true);
    expect(service.defaultProvider).toBe("anthropic");
    expect(service.providerNames).toContain("anthropic");
    expect(typeof service.complete).toBe("function");
    expect(typeof service.completeStream).toBe("function");
  });

  it("throws when defaultProvider is missing", () => {
    expect(() =>
      createAIService({
        defaultProvider: "",
        providers: {
          anthropic: { defaultModel: "claude-sonnet-4-20250514" },
        },
      } as AIServiceConfig),
    ).toThrow("defaultProvider is required");
  });

  it("throws when providers map is empty", () => {
    expect(() =>
      createAIService({
        defaultProvider: "anthropic",
        providers: {},
      }),
    ).toThrow("at least one provider");
  });

  it("throws when defaultProvider is not in providers map", () => {
    expect(() =>
      createAIService({
        defaultProvider: "anthropic",
        providers: {
          openai: { defaultModel: "gpt-4o" },
        },
      }),
    ).toThrow('Default provider "anthropic" is not defined');
  });

  it("throws when a provider has no defaultModel", () => {
    expect(() =>
      createAIService({
        defaultProvider: "anthropic",
        providers: {
          anthropic: { defaultModel: "" } as AIServiceConfig["providers"][string],
        },
      } as AIServiceConfig),
    ).toThrow("defaultModel");
  });

  it("throws when unknown provider name has no explicit type and no endpoint", () => {
    expect(() =>
      createAIService({
        defaultProvider: "custom",
        providers: {
          custom: {
            defaultModel: "my-model",
            // type and endpoint are both missing
          } as AIServiceConfig["providers"][string],
        },
      }),
    ).toThrow("type");
  });

  it("accepts custom provider with explicit type and endpoint", () => {
    const config: AIServiceConfig = {
      defaultProvider: "local",
      providers: {
        local: {
          defaultModel: "llama3",
          type: "openai",
          endpoint: "http://localhost:11434/v1",
        },
      },
    };

    const service = createAIService(config);
    expect(service.configured).toBe(true);
    expect(service.providerNames).toContain("local");
  });

  it("includes all providers in providerNames", () => {
    const config: AIServiceConfig = {
      defaultProvider: "anthropic",
      providers: {
        anthropic: { defaultModel: "claude-sonnet-4-20250514" },
        openai: { defaultModel: "gpt-4o" },
      },
    };

    const service = createAIService(config);
    expect(service.providerNames).toHaveLength(2);
    expect(service.providerNames).toContain("anthropic");
    expect(service.providerNames).toContain("openai");
  });
});

// ── resolveModel ───────────────────────────────────────────────

describe("resolveModel", () => {
  const config: AIServiceConfig = {
    defaultProvider: "anthropic",
    providers: {
      anthropic: {
        defaultModel: "claude-sonnet-4-20250514",
        models: {
          fast: "claude-haiku-4-5-20251001",
          advanced: "claude-opus-4-20250514",
        },
      },
      openai: {
        defaultModel: "gpt-4o",
        models: {
          fast: "gpt-4o-mini",
        },
      },
    },
  };

  it("returns default model when no provider or alias given", () => {
    const result = resolveModel(config);
    expect(result.provider).toBe("anthropic");
    expect(result.modelId).toBe("claude-sonnet-4-20250514");
  });

  it("resolves alias to model ID", () => {
    const result = resolveModel(config, "anthropic", "fast");
    expect(result.modelId).toBe("claude-haiku-4-5-20251001");
  });

  it("resolves advanced alias", () => {
    const result = resolveModel(config, "anthropic", "advanced");
    expect(result.modelId).toBe("claude-opus-4-20250514");
  });

  it("treats non-alias as literal model ID", () => {
    const result = resolveModel(config, "anthropic", "claude-3-haiku-20240307");
    expect(result.modelId).toBe("claude-3-haiku-20240307");
  });

  it("resolves from named provider", () => {
    const result = resolveModel(config, "openai", "fast");
    expect(result.provider).toBe("openai");
    expect(result.modelId).toBe("gpt-4o-mini");
  });

  it("returns default model for named provider when alias is undefined", () => {
    const result = resolveModel(config, "openai");
    expect(result.provider).toBe("openai");
    expect(result.modelId).toBe("gpt-4o");
  });

  it("throws for unknown provider", () => {
    expect(() => resolveModel(config, "nonexistent")).toThrow('Unknown AI provider');
  });
});

// ── resolveModelRoute ──────────────────────────────────────────

describe("resolveModelRoute", () => {
  it("returns undefined when routes is undefined", () => {
    expect(resolveModelRoute(undefined, "summarize")).toBeUndefined();
  });

  it("returns undefined when no route matches task type", () => {
    const routes = [{ taskType: "translate" as const, model: "gpt-4o" }];
    expect(resolveModelRoute(routes, "summarize")).toBeUndefined();
  });

  it("returns matching route for task type", () => {
    const routes = [
      { taskType: "summarize" as const, model: "claude-haiku-4-5-20251001", provider: "anthropic" },
      { taskType: "translate" as const, model: "gpt-4o", provider: "openai" },
    ];

    const result = resolveModelRoute(routes, "summarize");
    expect(result?.model).toBe("claude-haiku-4-5-20251001");
    expect(result?.provider).toBe("anthropic");
  });

  it("returns first matching route (no duplicate task types in practice)", () => {
    const routes = [
      { taskType: "code" as const, model: "first-model" },
      { taskType: "code" as const, model: "second-model" },
    ];

    const result = resolveModelRoute(routes, "code");
    expect(result?.model).toBe("first-model");
  });
});

// ── resolveTenantConfig ────────────────────────────────────────

describe("resolveTenantConfig", () => {
  const globalConfig: AIServiceConfig = {
    defaultProvider: "anthropic",
    providers: {
      anthropic: {
        defaultModel: "claude-sonnet-4-20250514",
      },
      openai: {
        defaultModel: "gpt-4o",
      },
    },
    limits: { maxTokens: 4096 },
    tenants: {
      "tenant-a": {
        providers: {
          anthropic: {
            defaultModel: "claude-haiku-4-5-20251001",
            apiKey: "$env.TENANT_A_ANTHROPIC_KEY",
          },
        },
        limits: { maxTokens: 1024 },
      },
    },
  };

  it("returns global config when tenant has no override", () => {
    const result = resolveTenantConfig(globalConfig, "unknown-tenant");
    expect(result).toBe(globalConfig); // same reference
  });

  it("merges tenant override into global config", () => {
    const result = resolveTenantConfig(globalConfig, "tenant-a");

    expect(result).not.toBe(globalConfig);
    // Tenant-specific model override
    expect(result.providers.anthropic.defaultModel).toBe("claude-haiku-4-5-20251001");
    // Other provider unchanged
    expect(result.providers.openai.defaultModel).toBe("gpt-4o");
  });

  it("tenant limits override global limits", () => {
    const result = resolveTenantConfig(globalConfig, "tenant-a");
    expect(result.limits?.maxTokens).toBe(1024);
  });

  it("preserves global limits when tenant has none", () => {
    const configWithTenantNoLimits: AIServiceConfig = {
      ...globalConfig,
      tenants: {
        "tenant-b": {
          providers: {},
        },
      },
    };

    const result = resolveTenantConfig(configWithTenantNoLimits, "tenant-b");
    expect(result.limits?.maxTokens).toBe(4096);
  });
});

// ── defaultAIConfig ────────────────────────────────────────────

describe("defaultAIConfig", () => {
  it("has anthropic as default provider", () => {
    expect(defaultAIConfig.defaultProvider).toBe("anthropic");
  });

  it("includes anthropic provider with model aliases", () => {
    const anthropic = defaultAIConfig.providers.anthropic;
    expect(anthropic).toBeDefined();
    expect(anthropic.defaultModel).toBeDefined();
    expect(anthropic.models?.fast).toBeDefined();
    expect(anthropic.models?.standard).toBeDefined();
    expect(anthropic.models?.advanced).toBeDefined();
  });

  it("is a valid config (passes createAIService validation)", () => {
    expect(() => createAIService(defaultAIConfig)).not.toThrow();
  });
});
