import { describe, expect, it } from "bun:test";
import {
  createAIService,
  createNoopAIService,
  defaultAIConfig,
  resolveModel,
} from "../src/engine/ai-service";
import type { AIServiceConfig } from "../src/types/ai";

// ── Test config ─────────────────────────────────────────────

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

// ── resolveModel tests ──────────────────────────────────────

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

// ── Config validation tests ─────────────────────────────────

describe("createAIService — config validation", () => {
  it("accepts a valid config", () => {
    expect(() => createAIService(testConfig)).not.toThrow();
  });

  it("rejects empty defaultProvider", () => {
    expect(() =>
      createAIService({
        defaultProvider: "",
        providers: { anthropic: { defaultModel: "claude-sonnet-4-20250514" } },
      }),
    ).toThrow("defaultProvider is required");
  });

  it("rejects empty providers", () => {
    expect(() => createAIService({ defaultProvider: "anthropic", providers: {} })).toThrow(
      "at least one provider",
    );
  });

  it("rejects when defaultProvider is not in providers", () => {
    expect(() =>
      createAIService({
        defaultProvider: "google",
        providers: { anthropic: { defaultModel: "claude-sonnet-4-20250514" } },
      }),
    ).toThrow('Default provider "google" is not defined');
  });

  it("rejects provider without defaultModel", () => {
    expect(() =>
      createAIService({
        defaultProvider: "anthropic",
        providers: {
          anthropic: { defaultModel: "" },
        },
      }),
    ).toThrow('Provider "anthropic" must have a defaultModel');
  });
});

// ── Default config test ─────────────────────────────────────

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

// ── Noop service tests ──────────────────────────────────────

describe("createNoopAIService", () => {
  it("throws on complete() with a helpful message", async () => {
    const noop = createNoopAIService();
    expect(() => noop.complete({ messages: [{ role: "user", content: "hello" }] })).toThrow(
      "AI service is not configured",
    );
  });
});

// ── Service instance tests (no API calls) ───────────────────

describe("createAIService", () => {
  it("returns an object with complete method", () => {
    const service = createAIService(testConfig);
    expect(typeof service.complete).toBe("function");
  });
});
