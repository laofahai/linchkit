import { describe, expect, it } from "bun:test";
import {
  type BaselineFile,
  createIntentScenario,
  createScenarioRegistry,
  type EvalFixture,
  type IntentEvalOutput,
  type IntentFixtureContext,
  type IntentFixtureInput,
} from "../../src/ai-eval";
import { buildOkResponse, inlineCatalog, makeMockAi, makeOntology } from "./helpers";

function fx(
  id: string,
  userMessage: string,
  catalogSource: string,
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

describe("createIntentScenario.runLive", () => {
  it("returns IntentEvalOutput with all fields populated", async () => {
    const scenario = createIntentScenario();
    const ai = makeMockAi({
      "5000": buildOkResponse({ amount: 5000, confidence: 0.85 }),
    });

    const output = await scenario.runLive(fx("ok", "create purchase 5000", "inline:purchase"), {
      ai,
      ontology: makeOntology(),
      loadInlineCatalog: async () => inlineCatalog(),
    });

    expect(output.action).toBe("create_purchase_request");
    expect(output.input.amount).toBe(5000);
    expect(output.confidence).toBe(0.85);
    expect(output.missingFields).toEqual([]);
    expect(output.explanation).toBe("ok");
    expect(typeof output.latencyMs).toBe("number");
  });

  it("returns null action when AI proposes an out-of-catalog action", async () => {
    const scenario = createIntentScenario();
    const ai = makeMockAi({
      hello: JSON.stringify({
        action: "fake_action",
        input: {},
        confidence: 0.9,
        explanation: "should be dropped",
      }),
    });
    const output = await scenario.runLive(fx("oc", "hello", "inline:purchase"), {
      ai,
      ontology: makeOntology(),
      loadInlineCatalog: async () => inlineCatalog(),
    });
    expect(output.action).toBe(null);
    expect(output.explanation).toMatch(/outside the catalog/);
  });

  it("surfaces missingFields for required inputs the AI did not fill", async () => {
    const scenario = createIntentScenario();
    const ai = makeMockAi({
      hello: JSON.stringify({
        action: "create_purchase_request",
        input: {},
        confidence: 0.8,
        explanation: "no amount",
      }),
    });
    const output = await scenario.runLive(fx("missing", "hello", "inline:purchase"), {
      ai,
      ontology: makeOntology(),
      loadInlineCatalog: async () => inlineCatalog(),
    });
    expect(output.missingFields).toEqual(["amount"]);
  });

  it("throws a clear error when inline catalog source is used without a loader", async () => {
    const scenario = createIntentScenario();
    const ai = makeMockAi({});
    await expect(
      scenario.runLive(fx("e", "msg", "inline:nope"), {
        ai,
        ontology: makeOntology(),
      }),
    ).rejects.toThrow(/requires deps\.loadInlineCatalog/);
  });

  it("rejects unknown catalogSource prefixes", async () => {
    const scenario = createIntentScenario();
    const ai = makeMockAi({});
    await expect(
      scenario.runLive(fx("e", "msg", "weird:source"), {
        ai,
        ontology: makeOntology(),
      }),
    ).rejects.toThrow(/unsupported catalogSource/);
  });
});

describe("createIntentScenario.replayFromBaseline", () => {
  const scenario = createIntentScenario();
  const baseline: BaselineFile<IntentEvalOutput> = {
    scenario: "intent",
    generatedAt: "2026-05-18T00:00:00.000Z",
    runnerVersion: "test",
    fixtures: [
      {
        fixtureId: "exists",
        fixtureHash: "h",
        aiOutput: {
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

  it("returns recorded entry by fixture id", () => {
    const out = scenario.replayFromBaseline(fx("exists", "ignored", "inline:purchase"), baseline);
    expect(out.action).toBe("create_purchase_request");
    expect(out.explanation).toBe("replayed");
  });

  it("throws when fixture is absent from baseline (spec §6.4 fail-loud)", () => {
    expect(() =>
      scenario.replayFromBaseline(fx("missing", "ignored", "inline:purchase"), baseline),
    ).toThrow(/no recorded AI output/);
  });

  it("throws when no baseline is loaded at all", () => {
    expect(() =>
      scenario.replayFromBaseline(fx("any", "ignored", "inline:purchase"), null),
    ).toThrow(/no canonical baseline loaded/);
  });
});

describe("createScenarioRegistry", () => {
  it("registers and retrieves scenario adapters by name", () => {
    const registry = createScenarioRegistry();
    const adapter = createIntentScenario();
    registry.register("intent", adapter);
    expect(registry.list()).toEqual(["intent"]);
    expect(registry.get("intent")).toBeDefined();
    expect(registry.get("unknown")).toBeUndefined();
  });

  it("throws when re-registering the same name", () => {
    const registry = createScenarioRegistry();
    registry.register("intent", createIntentScenario());
    expect(() => registry.register("intent", createIntentScenario())).toThrow(/already registered/);
  });
});
