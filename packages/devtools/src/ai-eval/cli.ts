/**
 * AI Eval CLI — argv parsing + flag wiring + cost banner + report orchestration.
 *
 * # Architecture note (addon-coupled defaults are intentional)
 *
 * `packages/devtools` MUST NOT import from `addons/` and an eval scenario
 * MUST call the production code it evaluates — those two rules pull in
 * opposite directions for scenario adapters. The resolution: scenario
 * adapters live in their owning capability package, and the CLI exposes
 * a `registerScenarios` callback so the addon entry script wires the
 * scenario adapter into the registry. The thin entry script lives in
 * `addons/ai-provider/cap-ai-provider/bin/ai-eval.ts` and dispatches here.
 *
 * The default fixture/baseline/catalog paths point at the cap-ai-provider
 * test tree. These are CONVENTIONAL paths, not imports — devtools never
 * loads addon code. Downstream consumers can override via flags.
 *
 * # Live-mode gate
 *
 * Live runs are triggered by `process.env.AI_EVAL_LIVE === "1"` (NOT a CLI
 * flag). Replay mode is the default and reads the canonical baseline JSON.
 *
 * # Flag order vs spec 69 §6.2
 *
 * The 7 invocations in the spec's §6.2 are all supported:
 *   1. `bun run ai:eval --scenario intent`
 *   2. `AI_EVAL_LIVE=1 bun run ai:eval --scenario intent --model <id>`
 *   3. `AI_EVAL_LIVE=1 bun run ai:eval --scenario intent --refresh-baseline`
 *   4. `AI_EVAL_LIVE=1 bun run ai:eval --scenario intent --force-refresh-baseline`
 *   5. `AI_EVAL_LIVE=1 bun run ai:eval --fixture <id>`
 *   6. `bun run ai:eval --scenario intent --diff <path>`
 *   7. `bun run ai:eval --diff-current` (paired with a live run, see notes)
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { compareToBaseline, loadCanonicalBaseline } from "./baseline";
import { registerIntentMatchers } from "./matchers/intent";
import { createMatcherRegistry } from "./matchers/registry";
import { renderJsonReport, renderMarkdownReport } from "./reporters";
import {
  estimateCost,
  loadFixtures,
  RegressionError,
  type RunDeps,
  type RunOptions,
  runEval,
} from "./runner";
import { createScenarioRegistry, type ScenarioRegistry } from "./scenarios/registry";
import type { BaselineFile, InlineCatalogAction, IntentEvalOutput, RunReport } from "./types";

// ── Conventional default paths (overridable via flags) ───────

const DEFAULT_FIXTURES_DIR_REL = "addons/ai-provider/cap-ai-provider/__tests__/eval/fixtures";
const DEFAULT_BASELINES_DIR_REL = "addons/ai-provider/cap-ai-provider/__tests__/eval/baselines";
const DEFAULT_CATALOGS_DIR_REL = "addons/ai-provider/cap-ai-provider/__tests__/eval/catalogs";
const DEFAULT_MAX_COST_USD = 5;
const DEFAULT_SCENARIO_HINT = "intent";

// ── Public types ────────────────────────────────────────────

export interface CliRunResult {
  /** Exit code the entry script should hand to `process.exit`. */
  exitCode: number;
  /** Markdown report — also printed to stdout when present. */
  markdownReport?: string;
}

export interface CliDeps {
  /**
   * Register scenario adapters into the runner's scenario registry. The
   * CLI itself never registers scenarios — the addon entry script owns
   * scenario wiring so it can import production code (e.g. resolveIntent
   * from cap-ai-provider) that the scenario must exercise.
   */
  registerScenarios: (registry: ScenarioRegistry) => void;
  /**
   * Live-mode dependencies. The factory is only invoked when the CLI is
   * actually about to call the AI service (i.e. AI_EVAL_LIVE === "1" and
   * the cost cap is not exceeded). Rejecting aborts the run with a clear
   * error message.
   *
   * The returned object is passed straight through to the runner as the
   * `deps` blob — its shape is opaque to the CLI; the scenario adapter
   * resolves what it needs. The CLI augments the returned object with the
   * resolved `model` and `catalogsDir` (the latter as a default disk
   * inline-catalog loader when none is supplied) under conventional keys
   * (`model`, `loadInlineCatalog`) so most adapters do not need to wire
   * them by hand.
   */
  loadLiveDeps: (ctx: {
    /** Resolved catalogs directory (CLI default + --catalogs-dir override). */
    catalogsDir: string;
    /** Effective model from --model, or undefined when not set. */
    model: string | undefined;
  }) => Promise<Record<string, unknown>>;
  /** Override the cwd used for default fixture/baseline/catalog roots. */
  cwd?: string;
  /** Stdout sink for the report. Defaults to `process.stdout.write`. */
  out?: (msg: string) => void;
  /** Stderr sink for banners + errors. Defaults to `process.stderr.write`. */
  err?: (msg: string) => void;
  /** When set, overrides `process.env.AI_EVAL_LIVE` reading (used by tests). */
  env?: NodeJS.ProcessEnv;
}

/** Parse argv and dispatch — top-level entry point exposed by devtools. */
export async function runCli(argv: string[], deps: CliDeps): Promise<CliRunResult> {
  const out = deps.out ?? defaultStdoutWriter;
  const err = deps.err ?? defaultStderrWriter;
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();

  let parsed: ParsedCli;
  try {
    parsed = parseCli(argv);
  } catch (e) {
    err(`${(e as Error).message}\n`);
    err(`Run \`bun run ai:eval --help\` for usage.\n`);
    return { exitCode: 1 };
  }

  if (parsed.help) {
    out(renderHelpText());
    return { exitCode: 0 };
  }

  // Standalone diff op: no eval run, just compare two baselines.
  if (parsed.diffPath) {
    return runDiffOp(parsed, { cwd, out, err });
  }

  // Eval run requires a scenario unless --fixture is provided (which still
  // needs SOMETHING to disambiguate the scenario registry lookup).
  const scenario = resolveScenario(parsed);
  if (!scenario) {
    err(
      "ERROR: --scenario <name> is required (or use --fixture <id> with a single registered scenario).\n",
    );
    return { exitCode: 1 };
  }

  const fixturesDir = parsed.fixturesDir ?? path.join(cwd, DEFAULT_FIXTURES_DIR_REL);
  const baselinesDir = parsed.baselinesDir ?? path.join(cwd, DEFAULT_BASELINES_DIR_REL);
  const catalogsDir = parsed.catalogsDir ?? path.join(cwd, DEFAULT_CATALOGS_DIR_REL);
  const live = env.AI_EVAL_LIVE === "1";
  const maxCostUsd = parsed.maxCostUsd ?? DEFAULT_MAX_COST_USD;

  // Always load fixtures first — used for the cost banner and the run.
  let fixtures: Awaited<ReturnType<typeof loadFixtures>>;
  try {
    fixtures = await loadFixtures({
      fixturesDir,
      scenario,
      fixtureFilter: parsed.fixture,
      tagFilter: parsed.tags.length > 0 ? parsed.tags : undefined,
    });
  } catch (e) {
    err(`ERROR loading fixtures: ${(e as Error).message}\n`);
    return { exitCode: 1 };
  }

  if (fixtures.length === 0) {
    err("ERROR: no fixtures matched the given filters.\n");
    return { exitCode: 1 };
  }

  // Cost banner + cap check happen BEFORE loadLiveDeps so that an over-budget
  // run aborts without bootstrapping the AIService.
  if (live) {
    const cost = estimateCost(fixtures, parsed.model ?? "default");
    const banner = renderCostBanner({
      scenario,
      fixtureCount: fixtures.length,
      model: parsed.model ?? "<scenario default>",
      cost,
      cap: maxCostUsd,
    });
    err(banner);
    if (cost.totalUsd > maxCostUsd) {
      err(
        `ERROR: estimated cost $${cost.totalUsd.toFixed(2)} exceeds --max-cost-usd ${maxCostUsd.toFixed(2)}.\n` +
          "       Reduce fixtures (--tag, --fixture) or raise the cap.\n",
      );
      return { exitCode: 1 };
    }
  }

  // Scenario registry — populated by the addon entry script through deps.
  const scenarioRegistry = createScenarioRegistry();
  deps.registerScenarios(scenarioRegistry);
  // Matcher registry: Phase 1 only the intent matchers ship in devtools;
  // additional matcher families would register here once they exist.
  const matcherRegistry = createMatcherRegistry<IntentEvalOutput>();
  registerIntentMatchers(matcherRegistry);

  // Live deps are only resolved when actually needed.
  let runDeps: Record<string, unknown> | undefined;
  if (live) {
    try {
      const liveDeps = await deps.loadLiveDeps({ catalogsDir, model: parsed.model });
      // Provide conventional fallbacks so most adapters do not need to wire
      // model / loadInlineCatalog by hand. The adapter can still override
      // by populating these keys explicitly in its returned object.
      runDeps = {
        loadInlineCatalog: makeDiskInlineLoader(catalogsDir),
        model: parsed.model,
        ...liveDeps,
      };
    } catch (e) {
      err(`ERROR loading live dependencies: ${(e as Error).message}\n`);
      return { exitCode: 1 };
    }
  }

  const runOpts: RunOptions = {
    scenario,
    fixturesDir,
    baselinesDir,
    live,
    deps: runDeps,
    refreshBaseline: parsed.refreshBaseline,
    forceRefreshBaseline: parsed.forceRefreshBaseline,
    maxCostUsd,
    fixtureFilter: parsed.fixture,
    tagFilter: parsed.tags.length > 0 ? parsed.tags : undefined,
    modelId: parsed.model,
    costPrinter: (msg) => err(`${msg}\n`),
  };

  let report: RunReport<IntentEvalOutput>;
  let regressed = false;
  try {
    report = await runEval<IntentEvalOutput>(runOpts, {
      scenarioRegistry,
      // Matcher registry is parameterised by IntentEvalOutput here; RunDeps
      // takes a generic registry. The narrowing is safe because the runner
      // only feeds IntentEvalOutput from the intent scenario into it.
      matcherRegistry: matcherRegistry as unknown as RunDeps["matcherRegistry"],
    });
  } catch (e) {
    if (e instanceof RegressionError) {
      // Spec §9.4: report MUST be printed even on regression so CI sees it.
      // The runner discards its internal report after throwing, so we
      // reconstruct the markdown from the diff alone.
      regressed = true;
      const md = renderRegressionOnlyReport(e);
      out(md);
      err(`REGRESSION: ${e.message}\n`);
      return { exitCode: 1, markdownReport: md };
    }
    err(`ERROR during eval: ${(e as Error).message}\n`);
    return { exitCode: 1 };
  }

  const fixtureTags = Object.fromEntries(fixtures.map((f) => [f.id, f.tags]));
  const markdown = renderMarkdownReport(report, {
    includeDiff: Boolean(report.diff),
    fixtureTags,
  });
  out(markdown);

  // Optional JSON artifact for CI uploads — separate from the canonical
  // baseline JSON the runner writes when --refresh-baseline is set.
  if (parsed.reportJson) {
    try {
      const { writeFile, mkdir } = await import("node:fs/promises");
      await mkdir(path.dirname(parsed.reportJson), { recursive: true });
      await writeFile(parsed.reportJson, renderJsonReport(report), "utf8");
    } catch (e) {
      err(`WARN: could not write --report-json: ${(e as Error).message}\n`);
    }
  }

  // --diff-current modifies a live run by comparing the in-memory report
  // against the canonical baseline. Replay-mode invocation with
  // --diff-current is meaningless (canonical == replay source) — surface
  // a clear error instead of silently passing.
  if (parsed.diffCurrent) {
    if (!live) {
      err(
        "ERROR: --diff-current requires a live run (set AI_EVAL_LIVE=1). " +
          "Replay mode compares the canonical against itself.\n",
      );
      return { exitCode: 1, markdownReport: markdown };
    }
    // The runner already populates report.diff when a prior baseline exists.
    // Treat the absence of a prior canonical as a soft warning (first-ever run).
    if (!report.diff) {
      err("NOTE: --diff-current produced no diff (no prior canonical baseline).\n");
    } else if (report.diff.hasRegression) {
      regressed = true;
      err(
        `REGRESSION detected by --diff-current: ${report.diff.summary.regressions} pass-to-fail.\n`,
      );
    }
  }

  return { exitCode: regressed ? 1 : 0, markdownReport: markdown };
}

// ── Standalone diff op (no eval run) ────────────────────────

async function runDiffOp(
  parsed: ParsedCli,
  ctx: { cwd: string; out: (msg: string) => void; err: (msg: string) => void },
): Promise<CliRunResult> {
  const scenario = resolveScenario(parsed);
  if (!scenario) {
    ctx.err("ERROR: --diff also requires --scenario <name> to locate the canonical baseline.\n");
    return { exitCode: 1 };
  }
  const baselinesDir = parsed.baselinesDir ?? path.join(ctx.cwd, DEFAULT_BASELINES_DIR_REL);

  let other: BaselineFile;
  try {
    const raw = await readFile(parsed.diffPath as string, "utf8");
    other = JSON.parse(raw) as BaselineFile;
  } catch (e) {
    ctx.err(`ERROR loading --diff baseline: ${(e as Error).message}\n`);
    return { exitCode: 1 };
  }

  const canonical = await loadCanonicalBaseline({
    scenario,
    baselinesDir,
    optional: true,
  });
  if (!canonical) {
    ctx.err(`ERROR: no canonical baseline found for scenario "${scenario}" at ${baselinesDir}.\n`);
    return { exitCode: 1 };
  }

  // Diff: treat canonical-on-disk as "current", argument file as "prior".
  // This matches the spec §6.2 example: `--diff baselines/intent/2026-05-20.json`
  // means "show me the drift FROM that historical baseline TO now".
  const synthetic: RunReport = {
    scenario,
    generatedAt: canonical.generatedAt,
    modelId: canonical.modelId,
    providerName: canonical.providerName,
    fixtures: canonical.fixtures,
    summary: {
      total: canonical.fixtures.length,
      strictPass: canonical.fixtures.filter((f) => f.passed).length,
      strictFail: canonical.fixtures.filter((f) => !f.passed).length,
      skipped: 0,
    },
  };
  const diff = compareToBaseline(synthetic, other);

  ctx.out(renderDiffOnlyReport(diff));
  return { exitCode: diff.hasRegression ? 1 : 0 };
}

// ── Argv parsing ────────────────────────────────────────────

interface ParsedCli {
  help: boolean;
  scenario?: string;
  fixture?: string;
  tags: string[];
  model?: string;
  refreshBaseline: boolean;
  forceRefreshBaseline: boolean;
  maxCostUsd?: number;
  diffPath?: string;
  diffCurrent: boolean;
  fixturesDir?: string;
  baselinesDir?: string;
  catalogsDir?: string;
  reportJson?: string;
}

function parseCli(argv: string[]): ParsedCli {
  const result = parseArgs({
    args: argv,
    allowPositionals: false,
    strict: true,
    options: {
      help: { type: "boolean", short: "h", default: false },
      scenario: { type: "string" },
      fixture: { type: "string" },
      tag: { type: "string", multiple: true, default: [] },
      model: { type: "string" },
      "refresh-baseline": { type: "boolean", default: false },
      "force-refresh-baseline": { type: "boolean", default: false },
      "max-cost-usd": { type: "string" },
      diff: { type: "string" },
      "diff-current": { type: "boolean", default: false },
      "fixtures-dir": { type: "string" },
      "baselines-dir": { type: "string" },
      "catalogs-dir": { type: "string" },
      "report-json": { type: "string" },
    },
  });

  const v = result.values;
  let maxCostUsd: number | undefined;
  if (typeof v["max-cost-usd"] === "string") {
    const parsed = Number.parseFloat(v["max-cost-usd"]);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error(`--max-cost-usd must be a positive number (got "${v["max-cost-usd"]}")`);
    }
    maxCostUsd = parsed;
  }

  const tags = Array.isArray(v.tag) ? v.tag.filter((t): t is string => typeof t === "string") : [];

  return {
    help: v.help === true,
    scenario: typeof v.scenario === "string" ? v.scenario : undefined,
    fixture: typeof v.fixture === "string" ? v.fixture : undefined,
    tags,
    model: typeof v.model === "string" ? v.model : undefined,
    refreshBaseline: v["refresh-baseline"] === true,
    forceRefreshBaseline: v["force-refresh-baseline"] === true,
    maxCostUsd,
    diffPath: typeof v.diff === "string" ? v.diff : undefined,
    diffCurrent: v["diff-current"] === true,
    fixturesDir: typeof v["fixtures-dir"] === "string" ? v["fixtures-dir"] : undefined,
    baselinesDir: typeof v["baselines-dir"] === "string" ? v["baselines-dir"] : undefined,
    catalogsDir: typeof v["catalogs-dir"] === "string" ? v["catalogs-dir"] : undefined,
    reportJson: typeof v["report-json"] === "string" ? v["report-json"] : undefined,
  };
}

function resolveScenario(parsed: ParsedCli): string | undefined {
  if (parsed.scenario) return parsed.scenario;
  // Single-fixture mode: only one scenario registered in Phase 1, so fall back
  // to the known default rather than forcing the user to repeat the flag.
  if (parsed.fixture) return DEFAULT_SCENARIO_HINT;
  return undefined;
}

// ── Disk-backed inline-catalog loader (used by default) ─────

function makeDiskInlineLoader(
  catalogsDir: string,
): (name: string) => Promise<ReadonlyArray<InlineCatalogAction>> {
  return async (name: string) => {
    const file = path.join(catalogsDir, `${name}.json`);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (e) {
      throw new Error(
        `could not load inline catalog "${name}" from ${file}: ${(e as Error).message}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`inline catalog ${file} is not valid JSON: ${(e as Error).message}`);
    }
    if (!parsed || typeof parsed !== "object") {
      throw new Error(`inline catalog ${file} must be an object`);
    }
    const actions = (parsed as { actions?: unknown }).actions;
    if (!Array.isArray(actions)) {
      throw new Error(`inline catalog ${file} must contain an "actions" array`);
    }
    return actions as ReadonlyArray<InlineCatalogAction>;
  };
}

// ── Banner + reports ────────────────────────────────────────

function renderCostBanner(opts: {
  scenario: string;
  fixtureCount: number;
  model: string;
  cost: { totalUsd: number; perFixtureUsd: number };
  cap: number;
}): string {
  const lines = [
    "==== AI Eval — live run ====",
    `Scenario: ${opts.scenario}`,
    `Fixtures: ${opts.fixtureCount}`,
    `Model:    ${opts.model}`,
    `Estimated cost: $${opts.cost.totalUsd.toFixed(2)} USD (~$${opts.cost.perFixtureUsd.toFixed(4)} per fixture)`,
    `Cap:      $${opts.cap.toFixed(2)} USD`,
    "============================",
    "",
  ];
  return lines.join("\n");
}

function renderRegressionOnlyReport(err: RegressionError): string {
  const d = err.diff;
  const lines: string[] = [];
  lines.push(`# AI Eval — REGRESSION — ${d.scenario}`);
  lines.push("");
  lines.push(`- Prior generated at: ${d.baselineGeneratedAt}`);
  lines.push(`- Current generated at: ${d.current.generatedAt}`);
  lines.push(`- Model: ${d.current.modelId ?? "n/a"}`);
  lines.push("");
  lines.push("## Summary");
  lines.push(`- Prior pass: ${d.summary.priorPass}`);
  lines.push(`- Current pass: ${d.summary.currentPass}`);
  lines.push(`- Delta: ${d.summary.delta} fixtures (${d.summary.deltaPp.toFixed(1)}pp)`);
  lines.push(`- Regressions (pass-to-fail): ${d.summary.regressions}`);
  lines.push("");
  const failures = d.byFixture.filter((f) => f.change === "pass-to-fail");
  if (failures.length > 0) {
    lines.push("## Pass-to-fail fixtures");
    for (const f of failures) {
      const newlyFailing = f.diff.newlyFailing.join(", ") || "n/a";
      lines.push(`- \`${f.fixtureId}\` — newly failing matchers: ${newlyFailing}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function renderDiffOnlyReport(diff: ReturnType<typeof compareToBaseline>): string {
  const lines: string[] = [];
  lines.push(`# AI Eval — diff — ${diff.scenario}`);
  lines.push("");
  lines.push(`- Baseline generated at: ${diff.baselineGeneratedAt}`);
  lines.push(`- Current generated at: ${diff.current.generatedAt}`);
  lines.push("");
  lines.push("## Summary");
  lines.push(`- Prior pass: ${diff.summary.priorPass}`);
  lines.push(`- Current pass: ${diff.summary.currentPass}`);
  lines.push(`- Delta: ${diff.summary.delta} fixtures (${diff.summary.deltaPp.toFixed(1)}pp)`);
  lines.push(`- Regressions (pass-to-fail): ${diff.summary.regressions}`);
  lines.push(`- Has regression: ${diff.hasRegression}`);
  lines.push("");
  const transitions = diff.byFixture.filter(
    (f) => f.change === "pass-to-fail" || f.change === "fail-to-pass",
  );
  if (transitions.length > 0) {
    lines.push("## Transitions");
    for (const f of transitions) {
      lines.push(`- \`${f.fixtureId}\` — ${f.change}`);
    }
    lines.push("");
  }
  // Per-fixture detail intentionally omitted — `cat <baseline>.current.json`
  // gives the full record when reviewers want to inspect a specific entry.
  return lines.join("\n");
}

// ── Help text ───────────────────────────────────────────────

function renderHelpText(): string {
  return `bun run ai:eval — AI Evaluation Framework CLI (spec 69)

USAGE
  bun run ai:eval [OPTIONS]

OPTIONS
  --scenario <name>             Scenario to run (required unless --fixture is set). Phase 1: "intent"
  --fixture <id>                Run a single fixture by id
  --tag <name>                  Filter by tag (repeatable; fixture must carry ALL listed tags)
  --model <id>                  Override scenario model (default: scenario's standard alias)
  --refresh-baseline            On a live run with no regression, overwrite canonical baseline
  --force-refresh-baseline      On a live run, overwrite canonical baseline regardless of diff
  --max-cost-usd <n>            Hard cap on estimated USD spend (default: 5)
  --diff <path>                 Compare current canonical against the given baseline JSON
  --diff-current                After a live run, compare in-memory result against canonical (modifies live run)
  --fixtures-dir <path>         Override fixture root
  --baselines-dir <path>        Override baseline root
  --catalogs-dir <path>         Override inline-catalog root
  --report-json <path>          Also write the full RunReport JSON to this path (for CI)
  --help, -h                    Show this help and exit 0

LIVE MODE
  Live runs require the env var AI_EVAL_LIVE=1. Without it, the CLI runs in
  replay mode using the committed canonical baseline JSON.

EXAMPLES (spec 69 §6.2)
  # Replay (default) — no network, runs in CI
  bun run ai:eval --scenario intent

  # Live, measure-only — diffs against canonical, never overwrites it
  AI_EVAL_LIVE=1 bun run ai:eval --scenario intent --model claude-sonnet-4-20250514

  # Live, refresh canonical if no regression
  AI_EVAL_LIVE=1 bun run ai:eval --scenario intent --refresh-baseline

  # Live, force-refresh canonical regardless of diff
  AI_EVAL_LIVE=1 bun run ai:eval --scenario intent --force-refresh-baseline

  # Single-fixture debugging
  AI_EVAL_LIVE=1 bun run ai:eval --fixture create_purchase_simple_zh

  # Diff against a historical baseline
  bun run ai:eval --scenario intent --diff baselines/intent/2026-05-20.json

  # Combined live + diff-current (CI usage — see workflow in spec §9.3)
  AI_EVAL_LIVE=1 bun run ai:eval --scenario intent --diff-current
`;
}

// ── Default IO writers ──────────────────────────────────────

function defaultStdoutWriter(msg: string): void {
  process.stdout.write(msg);
}

function defaultStderrWriter(msg: string): void {
  process.stderr.write(msg);
}
