import { describe, expect, it } from "bun:test";
import { createNoopAIService } from "../src/ai/ai-service";

describe("createNoopAIService", () => {
  it("returns an unconfigured service", () => {
    const noop = createNoopAIService();
    expect(noop.configured).toBe(false);
    expect(noop.defaultProvider).toBeNull();
    expect(noop.providerNames).toEqual([]);
  });

  it("throws on complete() with a helpful message", () => {
    const noop = createNoopAIService();
    expect(() => noop.complete({ messages: [{ role: "user", content: "hello" }] })).toThrow(
      "AI service is not configured. Add an 'ai' section to your LinchKit config.",
    );
  });
});
