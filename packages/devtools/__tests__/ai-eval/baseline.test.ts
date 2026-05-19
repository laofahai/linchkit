import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type BaselineFile,
  canonicalPath,
  compareToBaseline,
  datedArchivePath,
  type EvalFixture,
  findBaselineEntry,
  hashFixture,
  type IntentEvalOutput,
  loadCanonicalBaseline,
  type RunReport,
  writeCanonicalBaseline,
} from "../../src/ai-eval";

let workdir: string;
beforeEach(async () => {
  workdir = await mkdtemp(path.join(tmpdir(), "ai-eval-baseline-"));
});
afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

function buildReport(
  overrides: Partial<RunReport<IntentEvalOutput>> = {},
): RunReport<IntentEvalOutput> {
  const ts = new Date("2026-05-18T00:00:00.000Z").toISOString();
  return {
    scenario: "intent",
    generatedAt: ts,
    modelId: "mock-model",
    providerName: "mock",
    fixtures: [
      {
        fixtureId: "a",
        fixtureHash: "h-a",
        aiOutput: {
          action: "create_purchase_request",
          input: {},
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
    ],
    summary: { total: 1, strictPass: 1, strictFail: 0, skipped: 0 },
    ...overrides,
  };
}

describe("loadCanonicalBaseline / writeCanonicalBaseline", () => {
  it("returns null when file is missing (optional default)", async () => {
    const loaded = await loadCanonicalBaseline({ scenario: "intent", baselinesDir: workdir });
    expect(loaded).toBeNull();
  });

  it("round-trips canonical baseline and writes dated archive when asked", async () => {
    const result = await writeCanonicalBaseline<IntentEvalOutput>({
      scenario: "intent",
      report: buildReport(),
      baselinesDir: workdir,
      writeDatedArchive: true,
    });
    expect(result.canonicalPath).toBe(canonicalPath("intent", workdir));
    const dated = datedArchivePath("intent", new Date("2026-05-18T00:00:00.000Z"), workdir);
    expect(result.datedPath).toBe(dated);
    await expect(stat(dated)).resolves.toBeTruthy();

    const loaded = await loadCanonicalBaseline<IntentEvalOutput>({
      scenario: "intent",
      baselinesDir: workdir,
    });
    expect(loaded?.scenario).toBe("intent");
    expect(loaded?.fixtures.length).toBe(1);
    expect(loaded?.fixtures[0]?.fixtureId).toBe("a");
  });
});

describe("hashFixture", () => {
  it("produces a stable hex digest", () => {
    const fx: EvalFixture = {
      id: "x",
      scenario: "intent",
      tags: [],
      description: "",
      input: { userMessage: "hi" },
      context: { catalogSource: "inline:c" },
      expected: { matchers: [] },
    };
    const h = hashFixture(fx);
    expect(h).toMatch(/^[a-f0-9]{64}$/);
  });

  it("ignores object key order in input/context", () => {
    const a: EvalFixture = {
      id: "x",
      scenario: "intent",
      tags: [],
      description: "",
      input: { a: 1, b: 2 } as Record<string, number>,
      context: { catalogSource: "inline:c", scope: { entityFilter: ["e"] } },
      expected: { matchers: [] },
    };
    const b: EvalFixture = {
      ...a,
      input: { b: 2, a: 1 } as Record<string, number>,
      context: { scope: { entityFilter: ["e"] }, catalogSource: "inline:c" },
    };
    expect(hashFixture(a)).toBe(hashFixture(b));
  });
});

describe("compareToBaseline", () => {
  it("computes pass/fail transitions and delta", async () => {
    const prior = buildReport();
    // Two fixtures prior: a=pass, b=pass
    prior.fixtures.push({
      fixtureId: "b",
      fixtureHash: "h-b",
      aiOutput: {
        action: "approve_purchase_request",
        input: {},
        confidence: 0.8,
        missingFields: [],
        explanation: "ok",
      },
      matcherResults: [
        {
          matcher: "action_equals",
          passed: true,
          strict: true,
          observed: "approve_purchase_request",
        },
      ],
      passed: true,
      timestamp: prior.generatedAt,
    });
    prior.summary = { total: 2, strictPass: 2, strictFail: 0, skipped: 0 };

    const written = await writeWrap(prior);

    const current = buildReport();
    current.fixtures.push({
      fixtureId: "b",
      fixtureHash: "h-b",
      aiOutput: {
        action: null,
        input: {},
        confidence: 0,
        missingFields: [],
        explanation: "bad",
      },
      matcherResults: [
        {
          matcher: "action_equals",
          passed: false,
          strict: true,
          observed: null,
          message: "expected approve_purchase_request, got null",
        },
      ],
      passed: false,
      timestamp: current.generatedAt,
    });
    current.summary = { total: 2, strictPass: 1, strictFail: 1, skipped: 0 };

    const diff = compareToBaseline(current, written);
    expect(diff.summary.priorPass).toBe(2);
    expect(diff.summary.currentPass).toBe(1);
    expect(diff.summary.delta).toBe(-1);
    expect(diff.summary.regressions).toBe(1);
    expect(diff.summary.deltaPp).toBeCloseTo(-50, 5);
    expect(diff.hasRegression).toBe(true);
    const bDiff = diff.byFixture.find((b) => b.fixtureId === "b");
    expect(bDiff?.change).toBe("pass-to-fail");
    expect(bDiff?.diff.newlyFailing).toContain("action_equals");
  });

  it("does not flag regression when hit rate is stable", () => {
    const prior = buildReport();
    const current = buildReport();
    const diff = compareToBaseline(current, prior);
    expect(diff.hasRegression).toBe(false);
    expect(diff.summary.regressions).toBe(0);
    expect(diff.summary.delta).toBe(0);
  });
});

describe("findBaselineEntry", () => {
  function makeFixture(id: string, userMessage = "hi"): EvalFixture {
    return {
      id,
      scenario: "intent",
      tags: [],
      description: "",
      input: { userMessage },
      context: { catalogSource: "inline:c" },
      expected: { matchers: [] },
    };
  }

  function makeBaseline(
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
            input: {},
            confidence: 0.9,
            missingFields: [],
            explanation: "ok",
          },
          matcherResults: [],
          passed: true,
          timestamp: "2026-05-18T00:00:00.000Z",
        },
      ],
    };
  }

  it("returns the recorded entry on the happy path", () => {
    const fx = makeFixture("happy");
    const baseline = makeBaseline(fx);
    const entry = findBaselineEntry<IntentEvalOutput>(fx, baseline);
    expect(entry.fixtureId).toBe("happy");
    expect(entry.aiOutput.action).toBe("create_purchase_request");
  });

  it("throws when baseline is null (fail-loud, mentions refresh-baseline)", () => {
    const fx = makeFixture("any");
    expect(() => findBaselineEntry<IntentEvalOutput>(fx, null)).toThrow(
      /no canonical baseline loaded.*--refresh-baseline/,
    );
  });

  it("throws when the fixture id is absent (fail-loud, mentions refresh-baseline)", () => {
    const fx = makeFixture("missing");
    const baseline = makeBaseline(makeFixture("present"));
    expect(() => findBaselineEntry<IntentEvalOutput>(fx, baseline)).toThrow(
      /no recorded AI output.*--refresh-baseline/,
    );
  });

  it("throws on hash drift (fixture input/context changed since baseline)", () => {
    const fx = makeFixture("drifted", "original-message");
    // Baseline records the hash of the ORIGINAL fixture shape …
    const baseline = makeBaseline(fx);
    // … but the fixture on disk has since been edited.
    const drifted = { ...fx, input: { userMessage: "changed-message" } };
    expect(() => findBaselineEntry<IntentEvalOutput>(drifted, baseline)).toThrow(/hash drift/);
    expect(() => findBaselineEntry<IntentEvalOutput>(drifted, baseline)).toThrow(
      /--refresh-baseline/,
    );
  });

  it("error messages include the fixture id for actionable debugging", () => {
    const fx = makeFixture("my_fixture_id");
    expect(() => findBaselineEntry<IntentEvalOutput>(fx, null)).toThrow(/"my_fixture_id"/);
  });
});

/** Helper: persist a RunReport as a BaselineFile and return the loaded file. */
async function writeWrap(report: RunReport<IntentEvalOutput>) {
  await writeCanonicalBaseline<IntentEvalOutput>({
    scenario: report.scenario,
    report,
    baselinesDir: workdir,
  });
  const loaded = await loadCanonicalBaseline<IntentEvalOutput>({
    scenario: report.scenario,
    baselinesDir: workdir,
  });
  if (!loaded) throw new Error("test setup failure: baseline did not load");
  return loaded;
}
