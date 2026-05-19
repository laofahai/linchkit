import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  canonicalPath,
  createMatcherRegistry,
  createScenarioRegistry,
  EvalFailureError,
  type EvalFixture,
  estimateCost,
  hashFixture,
  type IntentEvalOutput,
  type IntentFixtureContext,
  type IntentFixtureInput,
  RegressionError,
  registerIntentMatchers,
  runEval,
  writeCanonicalBaseline,
} from "../../src/ai-eval";
import { buildOkResponse, fixturesDirFromMap, makeMockAi, makeMockIntentScenario } from "./helpers";

interface TempDirs {
  fixtures: string;
  baselines: string;
  cleanup: () => Promise<void>;
}

async function makeTempDirs(): Promise<TempDirs> {
  const root = await mkdtemp(path.join(tmpdir(), "ai-eval-runner-"));
  const fixtures = path.join(root, "fixtures");
  const baselines = path.join(root, "baselines");
  return {
    fixtures,
    baselines,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

function fx(
  id: string,
  userMessage: string,
  matchers: EvalFixture["expected"]["matchers"],
  tags: string[] = ["happy_path"],
): EvalFixture<IntentFixtureInput, IntentFixtureContext> {
  return {
    id,
    scenario: "intent",
    tags,
    description: id,
    input: { userMessage },
    context: { catalogSource: "inline:purchase" },
    expected: { matchers },
  };
}

describe("runEval (live mode end-to-end)", () => {
  let dirs: TempDirs;

  beforeEach(async () => {
    dirs = await makeTempDirs();
  });
  afterEach(async () => {
    await dirs.cleanup();
  });

  it("runs two fixtures and aggregates pass/fail on an all-passing first-ever run", async () => {
    // Both fixtures pass their strict matchers — no EvalFailureError fires
    // and the report comes back normally. Mirrors a healthy first-time
    // live invocation that lands a fresh baseline.
    const fixtureA = fx("happy_path_ok_a", "create purchase 5000", [
      { name: "action_equals", args: { value: "create_purchase_request" } },
      { name: "confidence_min", args: { value: 0.7 } },
    ]);
    const fixtureB = fx("happy_path_ok_b", "create purchase 200", [
      { name: "action_equals", args: { value: "create_purchase_request" } },
      { name: "confidence_min", args: { value: 0.7 } },
    ]);
    await fixturesDirFromMap(dirs.fixtures, [fixtureA, fixtureB]);

    const ai = makeMockAi({
      "5000": buildOkResponse({ amount: 5000, confidence: 0.9 }),
      "200": buildOkResponse({ amount: 200, confidence: 0.8 }),
    });
    const scenarioRegistry = createScenarioRegistry();
    scenarioRegistry.register("intent", makeMockIntentScenario());
    const matcherRegistry = createMatcherRegistry<IntentEvalOutput>();
    registerIntentMatchers(matcherRegistry);

    const report = await runEval<IntentEvalOutput>(
      {
        scenario: "intent",
        fixturesDir: dirs.fixtures,
        live: true,
        deps: { ai },
        refreshBaseline: true,
        baselinesDir: dirs.baselines,
        modelId: "mock-sonnet",
        providerName: "mock",
        costPrinter: () => {},
      },
      { scenarioRegistry, matcherRegistry },
    );

    expect(report.summary.total).toBe(2);
    expect(report.summary.strictPass).toBe(2);
    expect(report.summary.strictFail).toBe(0);
    // First-ever live run → no prior baseline, so no diff.
    expect(report.diff).toBeUndefined();

    // Canonical was written.
    const canonical = canonicalPath("intent", dirs.baselines);
    const exists = await stat(canonical).then(
      () => true,
      () => false,
    );
    expect(exists).toBe(true);
    const written = JSON.parse(await readFile(canonical, "utf8"));
    expect(written.scenario).toBe("intent");
    expect(written.fixtures.length).toBe(2);
  });
});

describe("runEval absolute-floor failure (spec §9.4)", () => {
  let dirs: TempDirs;
  beforeEach(async () => {
    dirs = await makeTempDirs();
  });
  afterEach(async () => {
    await dirs.cleanup();
  });

  it("throws EvalFailureError on first-ever live run with strict failures and no prior baseline", async () => {
    // The exact bug spec §9.4 calls out: without this check, the first live
    // run that lands the CI workflow could pass with 0% strict hit rate
    // because diff-based regression detection has nothing to compare against.
    const fixtureGood = fx("ok_first_run", "create purchase 5000", [
      { name: "action_equals", args: { value: "create_purchase_request" } },
    ]);
    const fixtureBad = fx("fail_first_run", "create purchase 200", [
      { name: "action_equals", args: { value: "create_purchase_request" } },
      // Forced failure via impossibly high confidence floor.
      { name: "confidence_min", args: { value: 0.99 } },
    ]);
    await fixturesDirFromMap(dirs.fixtures, [fixtureGood, fixtureBad]);

    const ai = makeMockAi({
      "5000": buildOkResponse({ amount: 5000, confidence: 0.9 }),
      "200": buildOkResponse({ amount: 200, confidence: 0.8 }),
    });
    const scenarioRegistry = createScenarioRegistry();
    scenarioRegistry.register("intent", makeMockIntentScenario());
    const matcherRegistry = createMatcherRegistry<IntentEvalOutput>();
    registerIntentMatchers(matcherRegistry);

    let caught: unknown;
    try {
      await runEval<IntentEvalOutput>(
        {
          scenario: "intent",
          fixturesDir: dirs.fixtures,
          live: true,
          deps: { ai },
          refreshBaseline: true,
          baselinesDir: dirs.baselines,
          modelId: "mock-sonnet",
          providerName: "mock",
          costPrinter: () => {},
        },
        { scenarioRegistry, matcherRegistry },
      );
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(EvalFailureError);
    const failure = caught as EvalFailureError<IntentEvalOutput>;
    expect(failure.kind).toBe("eval-failure");
    expect(failure.report.summary.strictFail).toBe(1);
    expect(failure.report.summary.strictPass).toBe(1);
    expect(failure.report.summary.total).toBe(2);
    // Baseline write is BLOCKED when strictFail > 0 (Codex R5-P2 fix):
    // refreshing a broken first run would commit failed outputs as the
    // replay source, corrupting the very thing the framework protects.
    // Use --force-refresh-baseline if you really need to capture a
    // known-bad baseline (e.g. for replicating the failure in CI).
    const canonical = canonicalPath("intent", dirs.baselines);
    const exists = await stat(canonical).then(
      () => true,
      () => false,
    );
    expect(exists).toBe(false);
  });

  it("does NOT throw EvalFailureError when all live fixtures pass strict matchers", async () => {
    const good = fx("only_good", "create purchase 5000", [
      { name: "action_equals", args: { value: "create_purchase_request" } },
    ]);
    await fixturesDirFromMap(dirs.fixtures, [good]);

    const ai = makeMockAi({
      "5000": buildOkResponse({ amount: 5000, confidence: 0.9 }),
    });
    const scenarioRegistry = createScenarioRegistry();
    scenarioRegistry.register("intent", makeMockIntentScenario());
    const matcherRegistry = createMatcherRegistry<IntentEvalOutput>();
    registerIntentMatchers(matcherRegistry);

    const report = await runEval<IntentEvalOutput>(
      {
        scenario: "intent",
        fixturesDir: dirs.fixtures,
        live: true,
        deps: { ai },
        baselinesDir: dirs.baselines,
        costPrinter: () => {},
      },
      { scenarioRegistry, matcherRegistry },
    );

    expect(report.summary.strictFail).toBe(0);
  });

  it("does NOT throw EvalFailureError in replay mode even when strict matchers fail", async () => {
    // Replay re-runs matchers against recorded outputs — strict failures
    // there reflect matcher-schema drift, which the `bun test` matcher
    // suite catches separately (spec §9.1). Throwing here would double-gate
    // the same condition.
    //
    // Seed a baseline whose recorded `aiOutput.action` does NOT satisfy the
    // fixture's `action_equals` matcher. Replay returns the recorded output
    // verbatim and the matcher fails — but the runner returns the report
    // instead of throwing because `opts.live` is false.
    const f = fx("replay_strictfail", "doesn't matter", [
      { name: "action_equals", args: { value: "create_purchase_request" } },
    ]);
    await fixturesDirFromMap(dirs.fixtures, [f]);

    await writeCanonicalBaseline<IntentEvalOutput>({
      scenario: "intent",
      baselinesDir: dirs.baselines,
      report: {
        scenario: "intent",
        generatedAt: new Date().toISOString(),
        fixtures: [
          {
            fixtureId: "replay_strictfail",
            fixtureHash: hashFixture(f),
            aiOutput: {
              // Intentionally mismatched action — will fail the matcher.
              action: "approve_purchase_request",
              input: {},
              confidence: 0.5,
              missingFields: [],
              explanation: "recorded",
            },
            matcherResults: [],
            passed: false,
            timestamp: new Date().toISOString(),
          },
        ],
        summary: { total: 1, strictPass: 0, strictFail: 1, skipped: 0 },
      },
    });

    const scenarioRegistry = createScenarioRegistry();
    scenarioRegistry.register("intent", makeMockIntentScenario());
    const matcherRegistry = createMatcherRegistry<IntentEvalOutput>();
    registerIntentMatchers(matcherRegistry);

    const report = await runEval<IntentEvalOutput>(
      {
        scenario: "intent",
        fixturesDir: dirs.fixtures,
        live: false,
        baselinesDir: dirs.baselines,
        costPrinter: () => {},
      },
      { scenarioRegistry, matcherRegistry },
    );

    // Returned, not thrown — but the failure is still visible in the summary.
    expect(report.summary.strictFail).toBe(1);
  });
});

describe("runEval cost cap", () => {
  let dirs: TempDirs;
  beforeEach(async () => {
    dirs = await makeTempDirs();
  });
  afterEach(async () => {
    await dirs.cleanup();
  });

  it("aborts before invoking the AI when estimated cost exceeds cap", async () => {
    const big = fx("huge", "msg", [
      { name: "action_equals", args: { value: "create_purchase_request" } },
    ]);
    big.meta = { estimatedTokens: { input: 1_000_000, output: 500_000 } };
    await fixturesDirFromMap(dirs.fixtures, [big]);

    let aiCalled = false;
    const ai = makeMockAi({}, () => {
      aiCalled = true;
    });
    const scenarioRegistry = createScenarioRegistry();
    scenarioRegistry.register("intent", makeMockIntentScenario());
    const matcherRegistry = createMatcherRegistry<IntentEvalOutput>();
    registerIntentMatchers(matcherRegistry);

    await expect(
      runEval<IntentEvalOutput>(
        {
          scenario: "intent",
          fixturesDir: dirs.fixtures,
          live: true,
          deps: { ai },
          maxCostUsd: 1,
          baselinesDir: dirs.baselines,
          costPrinter: () => {},
        },
        { scenarioRegistry, matcherRegistry },
      ),
    ).rejects.toThrow(/exceeds cap/);
    expect(aiCalled).toBe(false);
  });
});

describe("runEval regression handling", () => {
  let dirs: TempDirs;
  beforeEach(async () => {
    dirs = await makeTempDirs();
  });
  afterEach(async () => {
    await dirs.cleanup();
  });

  it("throws RegressionError on pass-to-fail and does NOT overwrite canonical without --force", async () => {
    const f = fx("regress_demo", "create purchase 5000", [
      { name: "action_equals", args: { value: "create_purchase_request" } },
    ]);
    await fixturesDirFromMap(dirs.fixtures, [f]);

    // Seed a prior baseline where the fixture passed.
    await writeCanonicalBaseline<IntentEvalOutput>({
      scenario: "intent",
      baselinesDir: dirs.baselines,
      report: {
        scenario: "intent",
        generatedAt: new Date().toISOString(),
        fixtures: [
          {
            fixtureId: "regress_demo",
            fixtureHash: "stub",
            aiOutput: {
              action: "create_purchase_request",
              input: { amount: 5000 },
              confidence: 0.9,
              missingFields: [],
              explanation: "prior",
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
            timestamp: new Date().toISOString(),
          },
        ],
        summary: { total: 1, strictPass: 1, strictFail: 0, skipped: 0 },
      },
    });

    // Mock AI returns a degraded (wrong-action) response → matcher fails.
    const ai = makeMockAi({
      "5000": JSON.stringify({
        action: "approve_purchase_request",
        input: {},
        confidence: 0.7,
        explanation: "degraded",
      }),
    });
    const scenarioRegistry = createScenarioRegistry();
    scenarioRegistry.register("intent", makeMockIntentScenario());
    const matcherRegistry = createMatcherRegistry<IntentEvalOutput>();
    registerIntentMatchers(matcherRegistry);

    const beforeCanonical = await readFile(canonicalPath("intent", dirs.baselines), "utf8");

    await expect(
      runEval<IntentEvalOutput>(
        {
          scenario: "intent",
          fixturesDir: dirs.fixtures,
          live: true,
          deps: { ai },
          refreshBaseline: true,
          baselinesDir: dirs.baselines,
          costPrinter: () => {},
        },
        { scenarioRegistry, matcherRegistry },
      ),
    ).rejects.toBeInstanceOf(RegressionError);

    const afterCanonical = await readFile(canonicalPath("intent", dirs.baselines), "utf8");
    expect(afterCanonical).toBe(beforeCanonical);
  });

  it("force-refresh overwrites canonical even with regressions, then still throws RegressionError", async () => {
    const f = fx("regress_force", "create purchase 5000", [
      { name: "action_equals", args: { value: "create_purchase_request" } },
    ]);
    await fixturesDirFromMap(dirs.fixtures, [f]);

    await writeCanonicalBaseline<IntentEvalOutput>({
      scenario: "intent",
      baselinesDir: dirs.baselines,
      report: {
        scenario: "intent",
        generatedAt: new Date().toISOString(),
        fixtures: [
          {
            fixtureId: "regress_force",
            fixtureHash: "stub",
            aiOutput: {
              action: "create_purchase_request",
              input: { amount: 5000 },
              confidence: 0.9,
              missingFields: [],
              explanation: "prior",
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
            timestamp: new Date().toISOString(),
          },
        ],
        summary: { total: 1, strictPass: 1, strictFail: 0, skipped: 0 },
      },
    });

    const ai = makeMockAi({
      "5000": JSON.stringify({
        action: "approve_purchase_request",
        input: {},
        confidence: 0.7,
        explanation: "degraded",
      }),
    });
    const scenarioRegistry = createScenarioRegistry();
    scenarioRegistry.register("intent", makeMockIntentScenario());
    const matcherRegistry = createMatcherRegistry<IntentEvalOutput>();
    registerIntentMatchers(matcherRegistry);

    await expect(
      runEval<IntentEvalOutput>(
        {
          scenario: "intent",
          fixturesDir: dirs.fixtures,
          live: true,
          deps: { ai },
          forceRefreshBaseline: true,
          baselinesDir: dirs.baselines,
          costPrinter: () => {},
        },
        { scenarioRegistry, matcherRegistry },
      ),
    ).rejects.toBeInstanceOf(RegressionError);

    const written = JSON.parse(await readFile(canonicalPath("intent", dirs.baselines), "utf8"));
    // Force-refresh wrote the degraded result (wrong action vs the fixture's expected one).
    expect(written.fixtures[0].aiOutput.action).toBe("approve_purchase_request");
    expect(written.fixtures[0].passed).toBe(false);
  });
});

describe("estimateCost", () => {
  it("uses fixture token meta when present", () => {
    const fixture: EvalFixture = {
      id: "x",
      scenario: "intent",
      tags: [],
      description: "",
      input: {},
      expected: { matchers: [] },
      meta: { estimatedTokens: { input: 1_000_000, output: 1_000_000 } },
    };
    const { totalUsd } = estimateCost([fixture], "any");
    // 1M input * $3 + 1M output * $15 = $18
    expect(totalUsd).toBeCloseTo(18, 5);
  });

  it("falls back to defaults when meta is absent", () => {
    const fixture: EvalFixture = {
      id: "x",
      scenario: "intent",
      tags: [],
      description: "",
      input: {},
      expected: { matchers: [] },
    };
    const { totalUsd } = estimateCost([fixture], "any");
    // 2000 input * 3e-6 + 500 output * 15e-6 = 0.006 + 0.0075 = 0.0135
    expect(totalUsd).toBeCloseTo(0.0135, 5);
  });
});

async function _appease(): Promise<void> {
  // Touch writeFile so the import isn't accidentally pruned by formatters.
  await writeFile("/dev/null", "");
}
void _appease;
