/**
 * CLI tests — argv parsing, env-driven live gating, cost cap, diff op,
 * regression report-still-printed semantics, and error surfaces.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type CliDeps,
  type EvalFixture,
  hashFixture,
  type IntentFixtureContext,
  type IntentFixtureInput,
  runCli,
  type ScenarioRegistry,
  writeCanonicalBaseline,
} from "../../src/ai-eval";
import { buildOkResponse, fixturesDirFromMap, makeMockAi, makeMockIntentScenario } from "./helpers";

interface TempLayout {
  root: string;
  fixturesDir: string;
  baselinesDir: string;
  catalogsDir: string;
  cleanup: () => Promise<void>;
}

async function makeLayout(): Promise<TempLayout> {
  const root = await mkdtemp(path.join(tmpdir(), "ai-eval-cli-"));
  return {
    root,
    fixturesDir: path.join(root, "fixtures"),
    baselinesDir: path.join(root, "baselines"),
    catalogsDir: path.join(root, "catalogs"),
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

function makeFixture(
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

interface CapturedIo {
  stdout: string;
  stderr: string;
  out: (msg: string) => void;
  err: (msg: string) => void;
}

function captureIo(): CapturedIo {
  const captured = { stdout: "", stderr: "" } as CapturedIo;
  captured.out = (msg) => {
    captured.stdout += msg;
  };
  captured.err = (msg) => {
    captured.stderr += msg;
  };
  return captured;
}

interface LiveDepsRecorder {
  called: boolean;
  factory: CliDeps["loadLiveDeps"];
}

function liveDepsRecorder(opts?: {
  aiResponses?: Record<string, string>;
  onAiCall?: () => void;
}): LiveDepsRecorder {
  const rec: LiveDepsRecorder = { called: false, factory: async () => ({}) };
  rec.factory = async () => {
    rec.called = true;
    return {
      ai: makeMockAi(opts?.aiResponses ?? {}, opts?.onAiCall),
    };
  };
  return rec;
}

/** Centralised registerScenarios for CLI tests — registers the mock scenario. */
const registerMockScenarios = (registry: ScenarioRegistry) => {
  registry.register("intent", makeMockIntentScenario());
};

describe("runCli — help", () => {
  it("prints usage and exits 0", async () => {
    const io = captureIo();
    const result = await runCli(["--help"], {
      registerScenarios: registerMockScenarios,
      loadLiveDeps: async () => {
        throw new Error("should not be called");
      },
      out: io.out,
      err: io.err,
    });
    expect(result.exitCode).toBe(0);
    expect(io.stdout).toContain("USAGE");
    expect(io.stdout).toContain("--scenario");
    expect(io.stdout).toContain("AI_EVAL_LIVE=1");
    expect(io.stderr).toBe("");
  });

  it("accepts -h as alias", async () => {
    const io = captureIo();
    const result = await runCli(["-h"], {
      registerScenarios: registerMockScenarios,
      loadLiveDeps: async () => {
        throw new Error("should not be called");
      },
      out: io.out,
      err: io.err,
    });
    expect(result.exitCode).toBe(0);
    expect(io.stdout).toContain("USAGE");
  });
});

describe("runCli — replay mode (no AI_EVAL_LIVE)", () => {
  let layout: TempLayout;
  beforeEach(async () => {
    layout = await makeLayout();
  });
  afterEach(async () => {
    await layout.cleanup();
  });

  it("never calls loadLiveDeps and replays from canonical baseline", async () => {
    const f = makeFixture("replay_ok", "create purchase 5000", [
      { name: "action_equals", args: { value: "create_purchase_request" } },
    ]);
    await fixturesDirFromMap(layout.fixturesDir, [f]);

    // Seed canonical baseline matching the fixture so replay passes. The
    // hash must be the REAL hash of the fixture — `findBaselineEntry` is
    // fail-loud on any drift, including stub hashes that were tolerated
    // before the P2 fix.
    await writeCanonicalBaseline({
      scenario: "intent",
      baselinesDir: layout.baselinesDir,
      report: {
        scenario: "intent",
        generatedAt: new Date().toISOString(),
        fixtures: [
          {
            fixtureId: "replay_ok",
            fixtureHash: hashFixture(f),
            aiOutput: {
              action: "create_purchase_request",
              input: { amount: 5000 },
              confidence: 0.9,
              missingFields: [],
              explanation: "ok",
            },
            matcherResults: [],
            passed: true,
            timestamp: new Date().toISOString(),
          },
        ],
        summary: { total: 1, strictPass: 1, strictFail: 0, skipped: 0 },
      },
    });

    const io = captureIo();
    const recorder = liveDepsRecorder();
    const result = await runCli(
      [
        "--scenario",
        "intent",
        "--fixtures-dir",
        layout.fixturesDir,
        "--baselines-dir",
        layout.baselinesDir,
      ],
      {
        registerScenarios: registerMockScenarios,
        loadLiveDeps: recorder.factory,
        out: io.out,
        err: io.err,
        env: {},
      },
    );

    expect(recorder.called).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(io.stdout).toContain("# AI Eval Baseline");
  });
});

describe("runCli — live mode (AI_EVAL_LIVE=1)", () => {
  let layout: TempLayout;
  beforeEach(async () => {
    layout = await makeLayout();
  });
  afterEach(async () => {
    await layout.cleanup();
  });

  it("invokes loadLiveDeps and prints cost banner to stderr", async () => {
    const f = makeFixture("live_ok", "create purchase 5000", [
      { name: "action_equals", args: { value: "create_purchase_request" } },
    ]);
    await fixturesDirFromMap(layout.fixturesDir, [f]);

    const io = captureIo();
    const recorder = liveDepsRecorder({
      aiResponses: { "5000": buildOkResponse({ amount: 5000, confidence: 0.9 }) },
    });
    const result = await runCli(
      [
        "--scenario",
        "intent",
        "--fixtures-dir",
        layout.fixturesDir,
        "--baselines-dir",
        layout.baselinesDir,
        "--model",
        "mock-sonnet",
      ],
      {
        registerScenarios: registerMockScenarios,
        loadLiveDeps: recorder.factory,
        out: io.out,
        err: io.err,
        env: { AI_EVAL_LIVE: "1" },
      },
    );

    expect(recorder.called).toBe(true);
    expect(io.stderr).toContain("==== AI Eval — live run ====");
    expect(io.stderr).toContain("Model:    mock-sonnet");
    expect(io.stderr).toContain("Cap:");
    expect(result.exitCode).toBe(0);
  });

  it("aborts before loadLiveDeps when --max-cost-usd is exceeded", async () => {
    const big = makeFixture("expensive", "create purchase 5000", [
      { name: "action_equals", args: { value: "create_purchase_request" } },
    ]);
    big.meta = { estimatedTokens: { input: 1_000_000, output: 500_000 } };
    await fixturesDirFromMap(layout.fixturesDir, [big]);

    const io = captureIo();
    const recorder = liveDepsRecorder();
    const result = await runCli(
      [
        "--scenario",
        "intent",
        "--fixtures-dir",
        layout.fixturesDir,
        "--baselines-dir",
        layout.baselinesDir,
        "--max-cost-usd",
        "0.01",
      ],
      {
        registerScenarios: registerMockScenarios,
        loadLiveDeps: recorder.factory,
        out: io.out,
        err: io.err,
        env: { AI_EVAL_LIVE: "1" },
      },
    );

    expect(recorder.called).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(io.stderr).toContain("exceeds --max-cost-usd");
  });
});

describe("runCli — filters", () => {
  let layout: TempLayout;
  beforeEach(async () => {
    layout = await makeLayout();
  });
  afterEach(async () => {
    await layout.cleanup();
  });

  it("--tag <name> repeated filters fixtures by every listed tag", async () => {
    const a = makeFixture(
      "tag_purchase_ok",
      "create purchase 5000",
      [{ name: "action_equals", args: { value: "create_purchase_request" } }],
      ["happy_path", "purchase"],
    );
    const b = makeFixture(
      "tag_purchase_only",
      "create purchase 100",
      [{ name: "action_equals", args: { value: "create_purchase_request" } }],
      ["purchase"],
    );
    const c = makeFixture(
      "tag_neither",
      "create purchase nothing",
      [{ name: "action_equals", args: { value: "create_purchase_request" } }],
      ["unrelated"],
    );
    await fixturesDirFromMap(layout.fixturesDir, [a, b, c]);

    const io = captureIo();
    const recorder = liveDepsRecorder({
      aiResponses: {
        "5000": buildOkResponse({ amount: 5000, confidence: 0.9 }),
        "100": buildOkResponse({ amount: 100, confidence: 0.9 }),
        nothing: buildOkResponse({ amount: 0, confidence: 0.9 }),
      },
    });
    const result = await runCli(
      [
        "--scenario",
        "intent",
        "--fixtures-dir",
        layout.fixturesDir,
        "--baselines-dir",
        layout.baselinesDir,
        "--tag",
        "happy_path",
        "--tag",
        "purchase",
      ],
      {
        registerScenarios: registerMockScenarios,
        loadLiveDeps: recorder.factory,
        out: io.out,
        err: io.err,
        env: { AI_EVAL_LIVE: "1" },
      },
    );

    expect(result.exitCode).toBe(0);
    // Only fixture with BOTH tags is `tag_purchase_ok`.
    expect(io.stdout).toContain("**Fixtures**: 1");
  });

  it("--fixture <id> selects a single fixture (defaults scenario to intent)", async () => {
    const a = makeFixture("one", "create purchase 5000", [
      { name: "action_equals", args: { value: "create_purchase_request" } },
    ]);
    const b = makeFixture("two", "create purchase 100", [
      { name: "action_equals", args: { value: "create_purchase_request" } },
    ]);
    await fixturesDirFromMap(layout.fixturesDir, [a, b]);

    const io = captureIo();
    const recorder = liveDepsRecorder({
      aiResponses: {
        "5000": buildOkResponse({ amount: 5000, confidence: 0.9 }),
      },
    });
    const result = await runCli(
      [
        "--fixture",
        "one",
        "--fixtures-dir",
        layout.fixturesDir,
        "--baselines-dir",
        layout.baselinesDir,
      ],
      {
        registerScenarios: registerMockScenarios,
        loadLiveDeps: recorder.factory,
        out: io.out,
        err: io.err,
        env: { AI_EVAL_LIVE: "1" },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(io.stdout).toContain("**Fixtures**: 1");
  });
});

describe("runCli — diff op", () => {
  let layout: TempLayout;
  beforeEach(async () => {
    layout = await makeLayout();
  });
  afterEach(async () => {
    await layout.cleanup();
  });

  it("--diff <path> compares two baselines without running eval", async () => {
    // Seed canonical AND a comparison file that differs.
    await writeCanonicalBaseline({
      scenario: "intent",
      baselinesDir: layout.baselinesDir,
      report: {
        scenario: "intent",
        generatedAt: "2026-05-18T00:00:00Z",
        fixtures: [
          {
            fixtureId: "f1",
            fixtureHash: "h",
            aiOutput: {},
            matcherResults: [],
            passed: true,
            timestamp: "2026-05-18T00:00:00Z",
          },
        ],
        summary: { total: 1, strictPass: 1, strictFail: 0, skipped: 0 },
      },
    });
    const otherPath = path.join(layout.root, "other.json");
    await writeFile(
      otherPath,
      JSON.stringify({
        scenario: "intent",
        generatedAt: "2026-05-10T00:00:00Z",
        runnerVersion: "ai-eval/0.1.0",
        fixtures: [
          {
            fixtureId: "f1",
            fixtureHash: "h",
            aiOutput: {},
            matcherResults: [],
            passed: true,
            timestamp: "2026-05-10T00:00:00Z",
          },
        ],
      }),
      "utf8",
    );

    const io = captureIo();
    const recorder = liveDepsRecorder();
    const result = await runCli(
      ["--scenario", "intent", "--diff", otherPath, "--baselines-dir", layout.baselinesDir],
      {
        registerScenarios: registerMockScenarios,
        loadLiveDeps: recorder.factory,
        out: io.out,
        err: io.err,
        env: {},
      },
    );

    expect(recorder.called).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(io.stdout).toContain("# AI Eval — diff");
    expect(io.stdout).toContain("Has regression: false");
  });
});

describe("runCli — regression still prints report", () => {
  let layout: TempLayout;
  beforeEach(async () => {
    layout = await makeLayout();
  });
  afterEach(async () => {
    await layout.cleanup();
  });

  it("exits 1 on regression and emits markdown to stdout", async () => {
    const f = makeFixture("regress", "create purchase 5000", [
      { name: "action_equals", args: { value: "create_purchase_request" } },
    ]);
    await fixturesDirFromMap(layout.fixturesDir, [f]);

    // Seed canonical where the fixture passed.
    await writeCanonicalBaseline({
      scenario: "intent",
      baselinesDir: layout.baselinesDir,
      report: {
        scenario: "intent",
        generatedAt: new Date().toISOString(),
        fixtures: [
          {
            fixtureId: "regress",
            fixtureHash: "h",
            aiOutput: {
              action: "create_purchase_request",
              input: {},
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

    const io = captureIo();
    const recorder = liveDepsRecorder({
      aiResponses: {
        "5000": JSON.stringify({
          action: "approve_purchase_request",
          input: {},
          confidence: 0.7,
          explanation: "wrong",
        }),
      },
    });
    const result = await runCli(
      [
        "--scenario",
        "intent",
        "--fixtures-dir",
        layout.fixturesDir,
        "--baselines-dir",
        layout.baselinesDir,
      ],
      {
        registerScenarios: registerMockScenarios,
        loadLiveDeps: recorder.factory,
        out: io.out,
        err: io.err,
        env: { AI_EVAL_LIVE: "1" },
      },
    );

    expect(result.exitCode).toBe(1);
    expect(io.stdout).toContain("REGRESSION");
    expect(io.stderr).toContain("REGRESSION:");
  });
});

describe("runCli — absolute-floor failure (spec §9.4)", () => {
  let layout: TempLayout;
  beforeEach(async () => {
    layout = await makeLayout();
  });
  afterEach(async () => {
    await layout.cleanup();
  });

  it("exits 1 and prints the markdown report when a live run has strict failures with no prior baseline", async () => {
    // This is the bug the brief calls out: without the absolute-floor check,
    // the very first live run with 100% strict failures would exit 0 because
    // there is no prior baseline to diff against. The CLI must surface the
    // failure AND still print the full report so CI logs are diagnostic.
    const f = makeFixture("first_run_fail", "create purchase 5000", [
      { name: "action_equals", args: { value: "create_purchase_request" } },
    ]);
    await fixturesDirFromMap(layout.fixturesDir, [f]);

    const io = captureIo();
    const recorder = liveDepsRecorder({
      aiResponses: {
        "5000": JSON.stringify({
          action: "approve_purchase_request",
          input: {},
          confidence: 0.7,
          explanation: "wrong",
        }),
      },
    });
    const result = await runCli(
      [
        "--scenario",
        "intent",
        "--fixtures-dir",
        layout.fixturesDir,
        "--baselines-dir",
        layout.baselinesDir,
      ],
      {
        registerScenarios: registerMockScenarios,
        loadLiveDeps: recorder.factory,
        out: io.out,
        err: io.err,
        env: { AI_EVAL_LIVE: "1" },
      },
    );

    expect(result.exitCode).toBe(1);
    expect(io.stderr).toContain("EVAL FAILURE:");
    expect(io.stdout).toContain("# AI Eval Baseline");
    // The markdown report carries the failed fixture so reviewers can diff
    // the actual aiOutput against expectations.
    expect(io.stdout).toContain("first_run_fail");
  });
});

describe("runCli — fresh-clone graceful handling (P1)", () => {
  let layout: TempLayout;
  beforeEach(async () => {
    layout = await makeLayout();
  });
  afterEach(async () => {
    await layout.cleanup();
  });

  it("replay mode with no canonical baseline exits 0 with a NOTICE", async () => {
    // Fixtures exist but no baseline has been generated yet — the default
    // first-time-clone state. Replay mode would normally crash inside the
    // runner; the CLI must catch this earlier and print actionable guidance.
    const f = makeFixture("fresh", "create purchase 5000", [
      { name: "action_equals", args: { value: "create_purchase_request" } },
    ]);
    await fixturesDirFromMap(layout.fixturesDir, [f]);

    const io = captureIo();
    let scenarioInvoked = false;
    const result = await runCli(
      [
        "--scenario",
        "intent",
        "--fixtures-dir",
        layout.fixturesDir,
        "--baselines-dir",
        layout.baselinesDir,
      ],
      {
        registerScenarios: (registry) => {
          // The scenario adapter must NOT be invoked at all — the early
          // notice should short-circuit before the runner spins up.
          registry.register("intent", {
            async runLive() {
              scenarioInvoked = true;
              throw new Error("runLive should not be called");
            },
            replayFromBaseline() {
              scenarioInvoked = true;
              throw new Error("replayFromBaseline should not be called");
            },
          });
        },
        loadLiveDeps: async () => {
          throw new Error("loadLiveDeps should not be called in replay mode");
        },
        out: io.out,
        err: io.err,
        env: {},
      },
    );

    expect(result.exitCode).toBe(0);
    expect(scenarioInvoked).toBe(false);
    expect(io.stderr).toContain("NOTICE: No canonical baseline yet");
    expect(io.stderr).toContain("--refresh-baseline");
    expect(io.stdout).toBe("");
  });

  it("--diff <path> with no canonical baseline exits 1 with a clear error", async () => {
    // --diff is the user explicitly asking to compare — fulfilling silently
    // would be worse than failing loudly.
    const otherPath = path.join(layout.root, "other.json");
    await writeFile(
      otherPath,
      JSON.stringify({
        scenario: "intent",
        generatedAt: "2026-05-10T00:00:00Z",
        runnerVersion: "ai-eval/0.1.0",
        fixtures: [],
      }),
      "utf8",
    );

    const io = captureIo();
    const result = await runCli(
      ["--scenario", "intent", "--diff", otherPath, "--baselines-dir", layout.baselinesDir],
      {
        registerScenarios: registerMockScenarios,
        loadLiveDeps: async () => {
          throw new Error("loadLiveDeps should not be called");
        },
        out: io.out,
        err: io.err,
        env: {},
      },
    );

    expect(result.exitCode).toBe(1);
    expect(io.stderr).toContain("no canonical baseline found");
  });

  it("--diff-current on a live run with no canonical baseline exits 0 with a note", async () => {
    // A first-ever live run wants to produce the baseline and diff against
    // nothing — the absence of a prior canonical is not an error here, just
    // a fact to surface to the operator.
    const f = makeFixture("first_live", "create purchase 5000", [
      { name: "action_equals", args: { value: "create_purchase_request" } },
    ]);
    await fixturesDirFromMap(layout.fixturesDir, [f]);

    const io = captureIo();
    const recorder = liveDepsRecorder({
      aiResponses: { "5000": buildOkResponse({ amount: 5000, confidence: 0.9 }) },
    });
    const result = await runCli(
      [
        "--scenario",
        "intent",
        "--fixtures-dir",
        layout.fixturesDir,
        "--baselines-dir",
        layout.baselinesDir,
        "--diff-current",
      ],
      {
        registerScenarios: registerMockScenarios,
        loadLiveDeps: recorder.factory,
        out: io.out,
        err: io.err,
        env: { AI_EVAL_LIVE: "1" },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(recorder.called).toBe(true);
    expect(io.stderr).toContain("no prior canonical baseline");
  });
});

describe("runCli — --catalogs-dir plumbing (P3)", () => {
  let layout: TempLayout;
  beforeEach(async () => {
    layout = await makeLayout();
  });
  afterEach(async () => {
    await layout.cleanup();
  });

  it("forwards --catalogs-dir override to loadLiveDeps ctx", async () => {
    // Without this, the addon entry script's own buildOntology used a
    // hardcoded path and silently ignored the flag — proven by an addon-
    // side regression. The CLI's job here is to make sure the override
    // makes it into loadLiveDeps' ctx so the addon can honor it.
    const f = makeFixture("catalog_p3", "create purchase 5000", [
      { name: "action_equals", args: { value: "create_purchase_request" } },
    ]);
    await fixturesDirFromMap(layout.fixturesDir, [f]);

    const customCatalogs = path.join(layout.root, "custom-catalogs");

    const observedCtx: Array<{ catalogsDir: string; model: string | undefined }> = [];
    const io = captureIo();
    const result = await runCli(
      [
        "--scenario",
        "intent",
        "--fixtures-dir",
        layout.fixturesDir,
        "--baselines-dir",
        layout.baselinesDir,
        "--catalogs-dir",
        customCatalogs,
        "--model",
        "mock-haiku",
      ],
      {
        registerScenarios: registerMockScenarios,
        loadLiveDeps: async (ctx) => {
          observedCtx.push({ catalogsDir: ctx.catalogsDir, model: ctx.model });
          return {
            ai: makeMockAi({ "5000": buildOkResponse({ amount: 5000, confidence: 0.9 }) }),
          };
        },
        out: io.out,
        err: io.err,
        env: { AI_EVAL_LIVE: "1" },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(observedCtx).toHaveLength(1);
    expect(observedCtx[0]?.catalogsDir).toBe(customCatalogs);
    expect(observedCtx[0]?.model).toBe("mock-haiku");
  });

  it("defaults --catalogs-dir to the conventional path under cwd when not overridden", async () => {
    const f = makeFixture("catalog_default", "create purchase 5000", [
      { name: "action_equals", args: { value: "create_purchase_request" } },
    ]);
    await fixturesDirFromMap(layout.fixturesDir, [f]);

    const observedCtx: Array<{ catalogsDir: string }> = [];
    const io = captureIo();
    const result = await runCli(
      [
        "--scenario",
        "intent",
        "--fixtures-dir",
        layout.fixturesDir,
        "--baselines-dir",
        layout.baselinesDir,
      ],
      {
        registerScenarios: registerMockScenarios,
        loadLiveDeps: async (ctx) => {
          observedCtx.push({ catalogsDir: ctx.catalogsDir });
          return {
            ai: makeMockAi({ "5000": buildOkResponse({ amount: 5000, confidence: 0.9 }) }),
          };
        },
        out: io.out,
        err: io.err,
        env: { AI_EVAL_LIVE: "1" },
        cwd: layout.root,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(observedCtx).toHaveLength(1);
    // Under the CLI's default convention rooted at cwd.
    expect(observedCtx[0]?.catalogsDir).toBe(
      path.join(layout.root, "addons/ai-provider/cap-ai-provider/__tests__/eval/catalogs"),
    );
  });
});

describe("runCli — argument errors", () => {
  it("exits 1 when neither --scenario nor --fixture is given", async () => {
    const io = captureIo();
    const result = await runCli([], {
      registerScenarios: registerMockScenarios,
      loadLiveDeps: async () => {
        throw new Error("not called");
      },
      out: io.out,
      err: io.err,
      env: {},
    });
    expect(result.exitCode).toBe(1);
    expect(io.stderr).toContain("--scenario <name>");
  });

  it("exits 1 on unknown flag", async () => {
    const io = captureIo();
    const result = await runCli(["--bogus"], {
      registerScenarios: registerMockScenarios,
      loadLiveDeps: async () => {
        throw new Error("not called");
      },
      out: io.out,
      err: io.err,
      env: {},
    });
    expect(result.exitCode).toBe(1);
    expect(io.stderr).toContain("--help");
  });

  it("exits 1 on invalid --max-cost-usd", async () => {
    const io = captureIo();
    const result = await runCli(["--scenario", "intent", "--max-cost-usd", "not-a-number"], {
      registerScenarios: registerMockScenarios,
      loadLiveDeps: async () => {
        throw new Error("not called");
      },
      out: io.out,
      err: io.err,
      env: {},
    });
    expect(result.exitCode).toBe(1);
    expect(io.stderr).toContain("--max-cost-usd");
  });
});
