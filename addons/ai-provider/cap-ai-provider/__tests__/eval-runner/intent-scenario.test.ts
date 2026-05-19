/**
 * Tests for the intent scenario adapter that ships from cap-ai-provider.
 *
 * Critically: the mock applies at the AIService boundary, NOT at the
 * resolveIntent boundary. That way the production prompt + parser +
 * reconciliation path runs on every test — the whole reason the
 * scenario adapter lives here instead of inside devtools.
 */

import { describe, expect, it } from "bun:test";
import type { AICompletionOptions, AICompletionResult, AIService } from "@linchkit/core";
import {
  type BaselineFile,
  type EvalFixture,
  hashFixture,
  type InlineCatalogAction,
  type IntentEvalOutput,
  type IntentFixtureContext,
  type IntentFixtureInput,
} from "@linchkit/devtools";
import { createIntentScenario, type IntentScenarioDeps } from "../../eval-runner/intent-scenario";

// ── Fixtures ─────────────────────────────────────────────────

function inlineCatalog(): InlineCatalogAction[] {
  return [
    {
      name: "create_purchase_request",
      entity: "purchase_request",
      label: "Create Purchase Request",
      description: "Submit a new purchase request",
      input: {
        amount: { type: "number", required: true, label: "Amount" },
        notes: { type: "string", required: false, label: "Notes" },
      },
    },
    {
      name: "approve_purchase_request",
      entity: "purchase_request",
      label: "Approve Purchase Request",
      input: {
        id: { type: "string", required: true, label: "Request ID" },
      },
    },
  ];
}

function makeFixture(
  id: string,
  userMessage: string,
  catalogSource = "inline:purchase",
): EvalFixture<IntentFixtureInput, IntentFixtureContext> {
  return {
    id,
    scenario: "intent",
    tags: ["happy_path"],
    description: id,
    input: { userMessage },
    context: { catalogSource },
    expected: { matchers: [] },
  };
}

/**
 * Mock AIService — picks a response by substring match against the
 * latest user message; falls back to a refusal JSON otherwise. The
 * scenario adapter calls `resolveIntent`, which in turn calls
 * `ai.complete()`. Mocking here exercises the full production path.
 *
 * `onCall` exposes the raw `AICompletionOptions` to tests that need to
 * assert what the production resolver forwarded (e.g. `model` plumbing).
 */
function makeMockAi(
  responses: Record<string, string>,
  onCall?: (options: AICompletionOptions) => void,
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

function makeDeps(ai: AIService): IntentScenarioDeps {
  return {
    ai,
    // Demo ontology is empty — fixtures use inline catalogs.
    ontology: {
      listEntities: () => [],
      actionsFor: () => [],
    },
    loadInlineCatalog: async () => inlineCatalog(),
  };
}

// ── Tests: runLive ──────────────────────────────────────────

describe("createIntentScenario.runLive", () => {
  it("returns IntentEvalOutput with all fields populated on a happy match", async () => {
    const scenario = createIntentScenario();
    const ai = makeMockAi({
      "5000": JSON.stringify({
        action: "create_purchase_request",
        input: { amount: 5000 },
        confidence: 0.85,
        explanation: "ok",
      }),
    });

    const output = await scenario.runLive(makeFixture("ok", "create purchase 5000"), makeDeps(ai));

    expect(output.action).toBe("create_purchase_request");
    expect(output.input.amount).toBe(5000);
    expect(output.confidence).toBe(0.85);
    expect(output.missingFields).toEqual([]);
    expect(output.explanation).toBe("ok");
    expect(typeof output.latencyMs).toBe("number");
    expect(output.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("returns null-equivalent IntentEvalOutput when the AI refuses with action: null", async () => {
    const scenario = createIntentScenario();
    const ai = makeMockAi({
      gibberish: JSON.stringify({
        action: null,
        input: {},
        confidence: 0,
        explanation: "no match",
      }),
    });

    const output = await scenario.runLive(makeFixture("refuse", "gibberish"), makeDeps(ai));
    expect(output.action).toBeNull();
    expect(output.confidence).toBe(0);
    expect(output.missingFields).toEqual([]);
    expect(output.input).toEqual({});
    expect(typeof output.latencyMs).toBe("number");
  });

  it("returns null-equivalent IntentEvalOutput on empty userMessage (resolveIntent refuses)", async () => {
    const scenario = createIntentScenario();
    const ai = makeMockAi({});

    const output = await scenario.runLive(makeFixture("empty", "   "), makeDeps(ai));
    expect(output.action).toBeNull();
    expect(output.confidence).toBe(0);
  });

  it("returns null-equivalent IntentEvalOutput when the AIService throws (resolveIntent absorbs)", async () => {
    const scenario = createIntentScenario();
    const throwingAi: AIService = {
      configured: true,
      defaultProvider: "mock",
      providerNames: ["mock"],
      complete: async () => {
        throw new Error("network down");
      },
    };

    const output = await scenario.runLive(
      makeFixture("net_err", "create purchase 5000"),
      makeDeps(throwingAi),
    );
    expect(output.action).toBeNull();
    expect(output.confidence).toBe(0);
  });

  it("surfaces alternatives from the AI response in IntentEvalOutput", async () => {
    const scenario = createIntentScenario();
    // Low primary confidence (<0.7) keeps alternatives in the output.
    const ai = makeMockAi({
      ambiguous: JSON.stringify({
        action: "approve_purchase_request",
        input: { id: "req-1" },
        confidence: 0.5,
        explanation: "primary",
        alternatives: [
          {
            action: "create_purchase_request",
            input: { amount: 100 },
            confidence: 0.45,
            explanation: "alt",
          },
        ],
      }),
    });

    const output = await scenario.runLive(makeFixture("alt", "ambiguous"), makeDeps(ai));
    expect(output.action).toBe("approve_purchase_request");
    expect(output.alternatives).toBeDefined();
    expect(output.alternatives?.length).toBe(1);
    expect(output.alternatives?.[0]?.action).toBe("create_purchase_request");
  });

  it("throws a clear error when inline catalog source is used without a loader", async () => {
    const scenario = createIntentScenario();
    const ai = makeMockAi({});
    const deps: IntentScenarioDeps = {
      ai,
      ontology: { listEntities: () => [], actionsFor: () => [] },
    };
    await expect(scenario.runLive(makeFixture("e", "msg", "inline:nope"), deps)).rejects.toThrow(
      /requires deps\.loadInlineCatalog/,
    );
  });

  it("rejects unknown catalogSource prefixes", async () => {
    const scenario = createIntentScenario();
    await expect(
      scenario.runLive(makeFixture("e", "msg", "weird:source"), makeDeps(makeMockAi({}))),
    ).rejects.toThrow(/unsupported catalogSource/);
  });

  it("forwards deps.model to resolveIntent → ai.complete (Spec 69 P2)", async () => {
    // Verifies the full pipeline: CLI --model → cliDeps.loadLiveDeps
    // → deps.model → intent scenario → resolveIntent → ai.complete().
    // Without this plumbing the eval framework records a model name in
    // the report that doesn't match what the AIService actually used.
    const scenario = createIntentScenario();
    const observed: AICompletionOptions[] = [];
    const ai = makeMockAi(
      {
        "5000": JSON.stringify({
          action: "create_purchase_request",
          input: { amount: 5000 },
          confidence: 0.85,
          explanation: "ok",
        }),
      },
      (opts) => observed.push(opts),
    );

    const deps: IntentScenarioDeps = {
      ...makeDeps(ai),
      model: "claude-haiku-4-5-20251001",
    };
    await scenario.runLive(makeFixture("ok", "create purchase 5000"), deps);

    expect(observed).toHaveLength(1);
    expect(observed[0]?.model).toBe("claude-haiku-4-5-20251001");
  });

  it("omits model from ai.complete when deps.model is unset (preserves default)", async () => {
    const scenario = createIntentScenario();
    const observed: AICompletionOptions[] = [];
    const ai = makeMockAi(
      {
        "5000": JSON.stringify({
          action: "create_purchase_request",
          input: { amount: 5000 },
          confidence: 0.85,
          explanation: "ok",
        }),
      },
      (opts) => observed.push(opts),
    );

    await scenario.runLive(makeFixture("ok", "create purchase 5000"), makeDeps(ai));

    expect(observed).toHaveLength(1);
    expect(observed[0]?.model).toBeUndefined();
  });

  it("requires catalogSource on the fixture context", async () => {
    const scenario = createIntentScenario();
    const fx: EvalFixture<IntentFixtureInput, IntentFixtureContext> = {
      id: "no_ctx",
      scenario: "intent",
      tags: [],
      description: "",
      input: { userMessage: "hi" },
      expected: { matchers: [] },
    };
    await expect(scenario.runLive(fx, makeDeps(makeMockAi({})))).rejects.toThrow(
      /catalogSource is required/,
    );
  });
});

// ── Tests: replayFromBaseline (P2 coverage — hash drift) ────

describe("createIntentScenario.replayFromBaseline", () => {
  const scenario = createIntentScenario();

  function recordedFixture(): EvalFixture<IntentFixtureInput, IntentFixtureContext> {
    return makeFixture("recorded", "stable-message");
  }

  function baselineFor(
    fx: EvalFixture,
    overrides?: { fixtureHash?: string; aiOutput?: IntentEvalOutput },
  ): BaselineFile<IntentEvalOutput> {
    return {
      scenario: "intent",
      generatedAt: "2026-05-18T00:00:00.000Z",
      runnerVersion: "test",
      fixtures: [
        {
          fixtureId: fx.id,
          fixtureHash: overrides?.fixtureHash ?? hashFixture(fx),
          aiOutput: overrides?.aiOutput ?? {
            action: "create_purchase_request",
            input: { amount: 1 },
            confidence: 1,
            missingFields: [],
            explanation: "replayed",
          },
          matcherResults: [],
          passed: true,
          timestamp: "2026-05-18T00:00:00.000Z",
        },
      ],
    };
  }

  it("returns the recorded entry by fixture id on the happy path", () => {
    const fx = recordedFixture();
    const out = scenario.replayFromBaseline(fx, baselineFor(fx));
    expect(out.action).toBe("create_purchase_request");
    expect(out.explanation).toBe("replayed");
  });

  it("throws when no baseline is loaded at all (spec §6.4 fail-loud)", () => {
    expect(() => scenario.replayFromBaseline(recordedFixture(), null)).toThrow(
      /no canonical baseline loaded/,
    );
  });

  it("throws when the fixture id is absent in the baseline (spec §6.4 fail-loud)", () => {
    const fx = recordedFixture();
    const stranger = makeFixture("not_in_baseline", "different");
    expect(() => scenario.replayFromBaseline(stranger, baselineFor(fx))).toThrow(
      /no recorded AI output/,
    );
  });

  it("throws on hash drift — fixture changed since baseline was written (P2 fix)", () => {
    const original = recordedFixture();
    const baseline = baselineFor(original);
    // Same id, but the fixture's userMessage was edited.
    const edited: EvalFixture<IntentFixtureInput, IntentFixtureContext> = {
      ...original,
      input: { userMessage: "edited-message" },
    };
    expect(() => scenario.replayFromBaseline(edited, baseline)).toThrow(/hash drift/);
  });
});
