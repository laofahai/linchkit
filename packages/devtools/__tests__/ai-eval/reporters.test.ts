import { describe, expect, it } from "bun:test";
import {
  type IntentEvalOutput,
  type RunReport,
  renderJsonReport,
  renderMarkdownReport,
} from "../../src/ai-eval";

function buildReport(): RunReport<IntentEvalOutput> {
  const ts = "2026-05-18T00:00:00.000Z";
  return {
    scenario: "intent",
    generatedAt: ts,
    modelId: "claude-sonnet-4",
    providerName: "anthropic",
    fixtures: [
      {
        fixtureId: "happy_path_ok",
        fixtureHash: "h1",
        aiOutput: {
          action: "create_purchase_request",
          input: { amount: 5000 },
          confidence: 0.9,
          missingFields: [],
          explanation: "ok",
        },
        matcherResults: [
          {
            matcher: "action_equals",
            passed: true,
            strict: true,
            observed: "create_purchase_request",
          },
        ],
        passed: true,
        timestamp: ts,
      },
      {
        fixtureId: "ambiguous_fail",
        fixtureHash: "h2",
        aiOutput: {
          action: null,
          input: {},
          confidence: 0,
          missingFields: [],
          explanation: "unclear",
        },
        matcherResults: [
          {
            matcher: "action_equals",
            passed: false,
            strict: true,
            observed: null,
            message: "expected create_purchase_request, got null",
          },
        ],
        passed: false,
        timestamp: ts,
      },
    ],
    summary: {
      total: 2,
      strictPass: 1,
      strictFail: 1,
      skipped: 0,
      avgPrimaryConfidence: 0.45,
    },
  };
}

describe("renderMarkdownReport", () => {
  it("includes header, headline metrics, by-tag table, failures, and reproduction line", () => {
    const md = renderMarkdownReport(buildReport(), {
      fixtureTags: {
        happy_path_ok: ["happy_path"],
        ambiguous_fail: ["ambiguous"],
      },
    });
    expect(md).toContain("# AI Eval Baseline — intent — 2026-05-18");
    expect(md).toContain("## Headline metrics");
    expect(md).toContain("50.0% (1/2)");
    expect(md).toContain("## By tag");
    expect(md).toContain("| happy_path |");
    expect(md).toContain("| ambiguous |");
    expect(md).toContain("## Failures");
    expect(md).toContain("`ambiguous_fail`");
    expect(md).toContain("`action_equals`");
    expect(md).toContain("## Reproduction");
    expect(md).toContain("bun run ai:eval --scenario intent --model claude-sonnet-4");
  });

  it("renders 'None' when there are no failures", () => {
    const r = buildReport();
    r.fixtures = [r.fixtures[0] as RunReport<IntentEvalOutput>["fixtures"][number]];
    r.summary = { total: 1, strictPass: 1, strictFail: 0, skipped: 0 };
    const md = renderMarkdownReport(r);
    expect(md).toContain("_None_");
  });

  it("includes diff section when includeDiff is true and report has a diff", () => {
    const r = buildReport();
    r.diff = {
      scenario: "intent",
      baselineGeneratedAt: "2026-05-10T00:00:00.000Z",
      current: { generatedAt: r.generatedAt },
      byFixture: [],
      summary: {
        priorPass: 2,
        currentPass: 1,
        delta: -1,
        regressions: 1,
        deltaPp: -50,
      },
      hasRegression: true,
    };
    const md = renderMarkdownReport(r, { includeDiff: true });
    expect(md).toContain("Diff vs prior canonical");
    expect(md).toContain("Regressions (pass-to-fail): 1");
  });
});

describe("renderJsonReport", () => {
  it("parses back to the identical report object", () => {
    const r = buildReport();
    const json = renderJsonReport(r);
    const parsed = JSON.parse(json);
    expect(parsed).toEqual(r);
  });
});
