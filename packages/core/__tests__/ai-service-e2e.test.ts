/**
 * E2E tests for AI Service — real API calls.
 *
 * Requires VOLCENGINE_API_KEY env var.
 * Run: VOLCENGINE_API_KEY=sk-xxx bun test packages/core/__tests__/ai-service-e2e.test.ts
 */
import { describe, expect, it } from "bun:test";
import { createAIService } from "@linchkit/cap-ai-provider";
import { z } from "zod";
import type { AIServiceConfig } from "../src/types/ai";

const apiKey = process.env.VOLCENGINE_API_KEY;

const config: AIServiceConfig = {
  defaultProvider: "volcengine",
  providers: {
    volcengine: {
      type: "openai",
      apiKey,
      endpoint: "https://ark.cn-beijing.volces.com/api/coding/v3",
      defaultModel: "ark-code-latest",
    },
  },
};

/**
 * Return true if the error looks like a Volcengine subscription/auth/payment
 * failure that should cause the test to skip rather than fail.
 * Re-throws anything else so real bugs still surface.
 *
 * Volcengine returns phrases like:
 *   "does not have a valid coding plan subscription"
 *   "your subscription has expired"
 *   HTTP 401/403 for invalid/expired keys
 * Match those specifically — don't swallow generic errors like
 * "insufficient context length".
 */
function isSubscriptionError(err: unknown): boolean {
  const messages: string[] = [];
  let current: unknown = err;
  // Walk up to 2 levels of `cause` chain.
  for (let i = 0; i < 3 && current != null; i++) {
    if (current instanceof Error) {
      messages.push(current.message);
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string") messages.push(code);
      current = (current as { cause?: unknown }).cause;
    } else {
      messages.push(String(current));
      break;
    }
  }
  const haystack = messages.join(" | ");
  return /subscription|coding plan|\b(unauthorized|forbidden)\b|\b40[13]\b|payment required|billing/i.test(
    haystack,
  );
}

describe.skipIf(!apiKey)("AI Service E2E — Volcengine", () => {
  const ai = createAIService(config);

  it("text completion returns a response", async () => {
    let result: Awaited<ReturnType<typeof ai.complete>>;
    try {
      result = await ai.complete({
        messages: [{ role: "user", content: "Reply with exactly: hello" }],
        maxTokens: 50,
      });
    } catch (err) {
      if (isSubscriptionError(err)) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn("[e2e] skipped: Volcengine subscription/auth error:", msg);
        return;
      }
      throw err;
    }

    expect(result.content).toBeTruthy();
    expect(result.content.toLowerCase()).toContain("hello");
    expect(result.provider).toBe("volcengine");
    expect(result.model).toBe("ark-code-latest");
    expect(result.duration).toBeGreaterThan(0);
    expect(result.usage.totalTokens).toBeGreaterThan(0);
  }, 30_000);

  // Volcengine Auto mode does not support response_format: json_schema
  it.skip("structured output with Zod schema", async () => {
    const schema = z.object({
      color: z.string(),
      hex: z.string(),
    });

    const result = await ai.complete({
      messages: [
        {
          role: "user",
          content: "What is the hex code for the color red? Return JSON with color and hex fields.",
        },
      ],
      responseFormat: { type: "json", schema },
      maxTokens: 100,
    });

    expect(result.data).toBeDefined();
    const data = result.data as z.infer<typeof schema>;
    expect(data.color).toBeTruthy();
    expect(data.hex).toBeTruthy();
  }, 30_000);

  it("respects maxTokens limit", async () => {
    let result: Awaited<ReturnType<typeof ai.complete>>;
    try {
      result = await ai.complete({
        messages: [{ role: "user", content: "Count from 1 to 1000" }],
        maxTokens: 20,
      });
    } catch (err) {
      if (isSubscriptionError(err)) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn("[e2e] skipped: Volcengine subscription/auth error:", msg);
        return;
      }
      throw err;
    }

    // Should be truncated — output tokens near the limit
    expect(result.usage.outputTokens).toBeLessThanOrEqual(30);
  }, 30_000);
});
