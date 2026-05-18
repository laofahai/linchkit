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
