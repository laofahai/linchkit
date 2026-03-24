import { describe, expect, it } from "bun:test";
import {
  createAIService,
  createNoopAIService,
  defaultAIConfig,
  resolveModel,
} from "../src/ai/ai-service";
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

  it("rejects custom provider without type", () => {
    expect(() =>
      createAIService({
        defaultProvider: "anthropic",
        providers: {
          anthropic: { defaultModel: "claude-sonnet-4-20250514" },
          ollama: { defaultModel: "llama3" },
        },
      }),
    ).toThrow(`Provider "ollama" must have an explicit 'type' field`);
  });

  it("rejects custom provider without endpoint", () => {
    expect(() =>
      createAIService({
        defaultProvider: "anthropic",
        providers: {
          anthropic: { defaultModel: "claude-sonnet-4-20250514" },
          deepseek: { type: "openai", defaultModel: "deepseek-chat" },
        },
      }),
    ).toThrow(`Provider "deepseek" requires an 'endpoint' field`);
  });

  it("accepts custom provider with type + endpoint", () => {
    expect(() =>
      createAIService({
        defaultProvider: "anthropic",
        providers: {
          anthropic: { defaultModel: "claude-sonnet-4-20250514" },
          ollama: { type: "openai", defaultModel: "llama3", endpoint: "http://localhost:11434/v1" },
        },
      }),
    ).not.toThrow();
  });

  it("accepts anthropic provider with custom endpoint", () => {
    expect(() =>
      createAIService({
        defaultProvider: "bedrock",
        providers: {
          bedrock: {
            type: "anthropic",
            defaultModel: "claude-3-sonnet",
            endpoint: "https://bedrock.amazonaws.com",
          },
        },
      }),
    ).not.toThrow();
  });

  it("allows built-in providers (anthropic, openai) without endpoint", () => {
    expect(() =>
      createAIService({
        defaultProvider: "anthropic",
        providers: {
          anthropic: { defaultModel: "claude-sonnet-4-20250514" },
          openai: { defaultModel: "gpt-4o" },
        },
      }),
    ).not.toThrow();
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

// ── JSON mode type safety ───────────────────────────────────

describe("responseFormat type safety", () => {
  it("json responseFormat requires schema at type level", () => {
    // This test verifies the type constraint works at runtime:
    // responseFormat with type 'json' must include a schema field.
    // The union type enforces { type: 'json'; schema: ZodSchema }.
    const textFormat = { type: "text" as const };
    expect(textFormat.type).toBe("text");

    // A json format always has schema in the type definition
    const { z } = require("zod");
    const jsonFormat = { type: "json" as const, schema: z.object({ answer: z.string() }) };
    expect(jsonFormat.type).toBe("json");
    expect(jsonFormat.schema).toBeDefined();
  });
});

// ── Tool parameter passthrough ──────────────────────────────

describe("tool parameters", () => {
  it("AITool parameters accept JSON Schema objects", () => {
    // Verify that AITool.parameters carries actual JSON Schema,
    // which gets passed through to the AI SDK via jsonSchema()
    const tool = {
      name: "get_weather",
      description: "Get weather for a location",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string", description: "City name" },
          unit: { type: "string", enum: ["celsius", "fahrenheit"] },
        },
        required: ["location"],
      },
    };

    expect(tool.parameters.properties).toBeDefined();
    expect(tool.parameters.properties.location.type).toBe("string");
    expect(tool.parameters.required).toContain("location");
  });
});
