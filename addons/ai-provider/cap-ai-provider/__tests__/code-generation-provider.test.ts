/**
 * CodeGenerationProvider (G5 Phase 1) — unit tests.
 *
 * Verifies the thin adapter over AIService: message shaping (context→system,
 * prompt→user), defaults (temperature 0, taskType "code"), option forwarding,
 * and the fail-loud behaviour when the AIService is not configured. A fake
 * AIService is injected — no real model is called.
 */

import { describe, expect, test } from "bun:test";
import type { AICompletionOptions, AICompletionResult, AIService } from "@linchkit/core";
import { createCodeGenerationProvider } from "../src/code-generation-provider";

function makeAI(opts: { configured?: boolean; content?: string } = {}): {
  ai: AIService;
  calls: AICompletionOptions[];
} {
  const calls: AICompletionOptions[] = [];
  const ai: AIService = {
    configured: opts.configured ?? true,
    defaultProvider: "glm",
    providerNames: ["glm"],
    async complete(options: AICompletionOptions): Promise<AICompletionResult> {
      calls.push(options);
      return {
        content: opts.content ?? "export const x = 1;",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        model: "glm-4",
        provider: "glm",
        duration: 1,
      };
    },
  };
  return { ai, calls };
}

describe("createCodeGenerationProvider", () => {
  test("returns the completion content verbatim", async () => {
    const { ai } = makeAI({ content: "export const late_fee = defineRule({});" });
    const provider = createCodeGenerationProvider(ai);
    const code = await provider.generateCode("Generate a late_fee rule");
    expect(code).toBe("export const late_fee = defineRule({});");
  });

  test("sends context as a system message and prompt as the user message", async () => {
    const { ai, calls } = makeAI();
    const provider = createCodeGenerationProvider(ai);
    await provider.generateCode("PROMPT", "CONTEXT");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.messages).toEqual([
      { role: "system", content: "CONTEXT" },
      { role: "user", content: "PROMPT" },
    ]);
    expect(calls[0]?.temperature).toBe(0);
    expect(calls[0]?.taskType).toBe("code");
  });

  test("omits the system message when no context is given", async () => {
    const { ai, calls } = makeAI();
    const provider = createCodeGenerationProvider(ai);
    await provider.generateCode("PROMPT");
    expect(calls[0]?.messages).toEqual([{ role: "user", content: "PROMPT" }]);
  });

  test("omits the system message for whitespace-only context", async () => {
    const { ai, calls } = makeAI();
    const provider = createCodeGenerationProvider(ai);
    await provider.generateCode("PROMPT", "   ");
    expect(calls[0]?.messages).toEqual([{ role: "user", content: "PROMPT" }]);
  });

  test("forwards model / maxTokens / temperature / tenantId / taskType overrides", async () => {
    const { ai, calls } = makeAI();
    const provider = createCodeGenerationProvider(ai, {
      model: "advanced",
      maxTokens: 2048,
      temperature: 0.2,
      tenantId: "t-1",
      taskType: "generation",
    });
    await provider.generateCode("PROMPT");
    expect(calls[0]?.model).toBe("advanced");
    expect(calls[0]?.maxTokens).toBe(2048);
    expect(calls[0]?.temperature).toBe(0.2);
    expect(calls[0]?.tenantId).toBe("t-1");
    expect(calls[0]?.taskType).toBe("generation");
  });

  test("throws when the AIService is not configured", async () => {
    const { ai } = makeAI({ configured: false });
    const provider = createCodeGenerationProvider(ai);
    await expect(provider.generateCode("PROMPT")).rejects.toThrow(/not configured/);
  });
});
