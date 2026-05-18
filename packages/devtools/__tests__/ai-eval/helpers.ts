/**
 * Test helpers shared across the ai-eval test suite.
 *
 * The framework no longer ships an intent scenario adapter (that moved
 * to `@linchkit/cap-ai-provider` so the eval exercises production code),
 * so the runner / CLI tests construct a tiny in-process scenario
 * adapter via `makeMockIntentScenario`. The adapter calls a mock
 * AIService and returns canned `IntentEvalOutput` shapes — enough to
 * drive the runner end-to-end without depending on any addon.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AICompletionOptions, AICompletionResult, AIService } from "@linchkit/core";
import {
  type BaselineFile,
  type EvalFixture,
  findBaselineEntry,
  type IntentEvalOutput,
  type IntentFixtureContext,
  type IntentFixtureInput,
  type ScenarioAdapter,
} from "../../src/ai-eval";

/** Build a Strict-JSON AI response that the mock scenario will accept. */
export function buildOkResponse(opts: {
  amount?: number;
  confidence?: number;
  action?: string;
  explanation?: string;
}): string {
  return JSON.stringify({
    action: opts.action ?? "create_purchase_request",
    input: opts.amount === undefined ? {} : { amount: opts.amount },
    confidence: opts.confidence ?? 0.9,
    explanation: opts.explanation ?? "ok",
  });
}

/**
 * Mock AIService that picks a response by substring match against the LAST
 * user message. Falls back to a refusal JSON when nothing matches so the
 * scenario adapter still parses successfully.
 */
export function makeMockAi(
  responses: Record<string, string>,
  onCall?: (opts: AICompletionOptions) => void,
): AIService {
  return {
    configured: true,
    defaultProvider: "mock",
    providerNames: ["mock"],
    async complete(options: AICompletionOptions): Promise<AICompletionResult> {
      onCall?.(options);
      const lastUser = [...options.messages].reverse().find((m) => m.role === "user");
      const userText = lastUser?.content ?? "";
      let body = JSON.stringify({
        action: null,
        input: {},
        confidence: 0,
        explanation: "no match in mock",
      });
      for (const [needle, value] of Object.entries(responses)) {
        if (userText.includes(needle)) {
          body = value;
          break;
        }
      }
      return {
        content: body,
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        model: "mock-model",
        provider: "mock",
        duration: 0,
      };
    },
  };
}

/** Persist fixtures to disk under `<dir>/<scenario>/<tag>/<id>.json`. */
export async function fixturesDirFromMap(dir: string, fixtures: EvalFixture[]): Promise<void> {
  for (const fx of fixtures) {
    const tag = fx.tags[0] ?? "untagged";
    const target = path.join(dir, fx.scenario, tag, `${fx.id}.json`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(fx, null, 2), "utf8");
  }
}

/**
 * Deps the mock intent scenario consumes. Mirrors the public-facing
 * `IntentScenarioDeps` from cap-ai-provider just closely enough that
 * the runner / CLI tests can drive the framework end-to-end without
 * importing addon code.
 */
export interface MockIntentScenarioDeps {
  ai: AIService;
}

/**
 * Tiny scenario adapter for runner / CLI tests. Sends the fixture's
 * `userMessage` to the mock AIService, parses the JSON envelope the
 * mock returns, and projects it into IntentEvalOutput. Intentionally
 * minimal — the production adapter under test for behavioural
 * correctness lives in `cap-ai-provider/__tests__/eval-runner/`.
 */
export function makeMockIntentScenario(): ScenarioAdapter<
  IntentFixtureInput,
  IntentFixtureContext,
  IntentEvalOutput,
  MockIntentScenarioDeps
> {
  return {
    async runLive(fx, deps) {
      const startedAt = performance.now();
      const result = await deps.ai.complete({
        messages: [
          { role: "system", content: "test-scenario" },
          { role: "user", content: fx.input.userMessage },
        ],
        temperature: 0,
      });
      const latencyMs = Math.round(performance.now() - startedAt);
      const parsed = parseLoose(result.content);
      return {
        action: typeof parsed.action === "string" ? parsed.action : null,
        input: (parsed.input as Record<string, unknown>) ?? {},
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
        missingFields: [],
        explanation: typeof parsed.explanation === "string" ? parsed.explanation : "",
        latencyMs,
      };
    },
    replayFromBaseline(fx, baseline: BaselineFile<IntentEvalOutput> | null) {
      const entry = findBaselineEntry<IntentEvalOutput>(fx, baseline);
      return entry.aiOutput;
    },
  };
}

function parseLoose(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
