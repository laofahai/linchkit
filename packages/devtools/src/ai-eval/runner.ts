/**
 * AI Eval runner — orchestrates fixture load → scenario invocation →
 * matcher dispatch → report aggregation → diff + baseline write.
 *
 * Implements the spec 69 §6.3 pseudocode verbatim, including the
 * always-load-prior-baseline policy and the `--refresh-baseline` /
 * `--force-refresh-baseline` write rules from §9.2.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  compareToBaseline,
  hashFixture,
  loadCanonicalBaseline,
  writeCanonicalBaseline,
} from "./baseline";
import type { MatcherRegistry } from "./matchers/registry";
import type { ScenarioRegistry } from "./scenarios/registry";
import type {
  BaselineDiff,
  BaselineFixtureEntry,
  EvalFixture,
  MatcherResult,
  RunReport,
} from "./types";

// ── Approximate-pricing constants ───────────────────────────

/**
 * Per-million-token USD pricing keyed by model-id prefix. Hard-coded here
 * because devtools must remain decoupled from `cap-ai-provider`'s
 * CostEstimator. Phase 2 may replace this with a pluggable hook injected
 * by the CLI's loadLiveDeps.
 *
 * Prefix-matched (longest-first), so dated variants like
 * `claude-sonnet-4-20250514` resolve to the `claude-sonnet-4` row.
 * Unknown models fall back to `FALLBACK_PRICING` (conservative Claude
 * Sonnet pricing) and emit a banner via the CLI's costPrinter so a
 * misconfigured run does not silently under-budget.
 */
const PRICING_PER_M_TOKENS: ReadonlyArray<{
  prefix: string;
  input: number;
  output: number;
}> = [
  // Anthropic (list price as of 2026-05)
  { prefix: "claude-opus-4", input: 15, output: 75 },
  { prefix: "claude-sonnet-4", input: 3, output: 15 },
  { prefix: "claude-haiku-4-5", input: 1, output: 5 },
  // Zhipu (https://open.bigmodel.cn/pricing — flash tier is effectively
  // free; air is the paid baseline. Numbers in USD-equivalent after CNY
  // conversion, rounded up to be conservative.)
  { prefix: "glm-4-flash", input: 0.001, output: 0.001 },
  { prefix: "glm-4-air", input: 0.07, output: 0.07 },
  { prefix: "glm-4-plus", input: 0.7, output: 0.7 },
  // OpenAI
  { prefix: "gpt-4o-mini", input: 0.15, output: 0.6 },
  { prefix: "gpt-4o", input: 2.5, output: 10 },
];
const FALLBACK_PRICING = { input: 3, output: 15 }; // conservative Claude Sonnet
const DEFAULT_INPUT_TOKENS = 2000;
const DEFAULT_OUTPUT_TOKENS = 500;
const DEFAULT_MAX_COST_USD = 5;

function resolvePricing(modelId: string | undefined): {
  input: number;
  output: number;
  matched: boolean;
} {
  if (!modelId) return { ...FALLBACK_PRICING, matched: false };
  const matches = PRICING_PER_M_TOKENS.filter((r) => modelId.startsWith(r.prefix)).sort(
    (a, b) => b.prefix.length - a.prefix.length,
  );
  const hit = matches[0];
  if (hit) return { input: hit.input, output: hit.output, matched: true };
  return { ...FALLBACK_PRICING, matched: false };
}

// ── Public types ────────────────────────────────────────────

export interface RunOptions {
  scenario: string;
  /** Path or directory containing fixture JSON files. */
  fixturesDir: string;
  /** When true, hits the live AI service via the scenario adapter. */
  live: boolean;
  /** Scenario-specific dependency bag — typed `unknown` at runner level. */
  deps?: unknown;
  refreshBaseline?: boolean;
  forceRefreshBaseline?: boolean;
  /** Hard ceiling on estimated USD cost. Default `DEFAULT_MAX_COST_USD`. */
  maxCostUsd?: number;
  /** Sink for the cost banner. Default: write to stderr. */
  costPrinter?: (msg: string) => void;
  /** Override the baselines root. */
  baselinesDir?: string;
  /** Exact-id filter for single-fixture debugging. */
  fixtureFilter?: string;
  /** Fixture must carry every listed tag. */
  tagFilter?: string[];
  /** Model id stamped into the report + baseline. */
  modelId?: string;
  /** Provider name stamped into the report + baseline. */
  providerName?: string;
  /**
   * When set with `live: false`, the runner injects this pre-loaded baseline
   * instead of reading from disk. Used by tests; the CLI never sets it.
   */
  injectPriorBaseline?: import("./types").BaselineFile;
}

export interface RunDeps {
  scenarioRegistry: ScenarioRegistry;
  /** Matcher registry the runner queries per fixture matcher invocation. */
  matcherRegistry: MatcherRegistry;
}

/** Thrown after the report is finalised to surface regressions to the CLI. */
export class RegressionError extends Error {
  constructor(public readonly diff: BaselineDiff) {
    super(
      `AI eval regression detected for scenario "${diff.scenario}": ` +
        `${diff.summary.regressions} pass-to-fail, deltaPp=${diff.summary.deltaPp.toFixed(1)}`,
    );
    this.name = "RegressionError";
  }
}

/**
 * Thrown when a live run finishes with at least one fixture failing strict
 * matchers — even without a prior canonical baseline to diff against.
 *
 * Distinct from `RegressionError`:
 *   - `RegressionError` = "got worse than the prior canonical baseline"
 *   - `EvalFailureError` = "absolute strict-matcher failure(s) observed"
 *
 * Spec 69 §9.4 requires the live job to fail on strict failures regardless
 * of whether a baseline existed; otherwise the very first live run can land
 * a green CI status while the strict hit rate is 0%.
 */
export class EvalFailureError<TOutput = unknown> extends Error {
  public readonly kind = "eval-failure" as const;
  constructor(public readonly report: RunReport<TOutput>) {
    super(
      `AI eval failed for scenario "${report.scenario}": ` +
        `${report.summary.strictFail}/${report.summary.total} ` +
        `fixtures had strict matcher failures.`,
    );
    this.name = "EvalFailureError";
  }
}

// ── Public API ──────────────────────────────────────────────

export async function runEval<TOutput = unknown>(
  opts: RunOptions,
  runDeps: RunDeps,
): Promise<RunReport<TOutput>> {
  const fixtures = await loadFixtures({
    fixturesDir: opts.fixturesDir,
    scenario: opts.scenario,
    fixtureFilter: opts.fixtureFilter,
    tagFilter: opts.tagFilter,
  });

  const scenarioAdapter = runDeps.scenarioRegistry.get(opts.scenario);
  if (!scenarioAdapter) {
    throw new Error(`runEval: no scenario registered for "${opts.scenario}"`);
  }

  // ALWAYS load the prior canonical baseline (spec 69 §6.3 corrected pseudocode).
  // Live mode uses it for diffing; replay mode uses it as the AI-output source.
  const priorBaseline =
    opts.injectPriorBaseline ??
    (await loadCanonicalBaseline<TOutput>({
      scenario: opts.scenario,
      baselinesDir: opts.baselinesDir,
      optional: true,
    }));

  if (opts.live) {
    const cost = estimateCost(fixtures, opts.modelId ?? "default");
    const printer = opts.costPrinter ?? defaultCostPrinter;
    const cap = opts.maxCostUsd ?? DEFAULT_MAX_COST_USD;
    const pricingNote = cost.pricingMatched
      ? `model ${opts.modelId}`
      : `UNKNOWN model "${opts.modelId ?? "default"}" — falling back to conservative Claude Sonnet pricing; actual cost may be much lower`;
    printer(
      `[ai-eval] live run cost estimate: $${cost.totalUsd.toFixed(2)} ` +
        `(${fixtures.length} fixtures × ~$${cost.perFixtureUsd.toFixed(4)}/fixture, cap $${cap.toFixed(2)}, ${pricingNote})`,
    );
    if (cost.totalUsd > cap) {
      throw new Error(
        `runEval: estimated cost $${cost.totalUsd.toFixed(2)} exceeds cap $${cap.toFixed(2)} ` +
          "(raise --max-cost-usd to proceed)",
      );
    }
  }

  const generatedAt = new Date().toISOString();
  const entries: BaselineFixtureEntry<TOutput>[] = [];
  const primaryConfidences: number[] = [];

  for (const fx of fixtures) {
    const aiOutput = opts.live
      ? await runLiveSafely<TOutput>(scenarioAdapter, fx, opts.deps)
      : ((await scenarioAdapter.replayFromBaseline(fx, priorBaseline)) as TOutput);

    const matcherResults = invokeMatchers(fx, aiOutput, runDeps.matcherRegistry);
    const passed = matcherResults.every((r) => !r.strict || r.passed);

    // Best-effort: surface intent scenario's primary confidence into the
    // report aggregate. The cast is the cheapest way to keep the runner
    // scenario-agnostic without bleeding intent types into the public API.
    const maybeIntent = aiOutput as { confidence?: unknown } | null;
    if (
      maybeIntent &&
      typeof maybeIntent === "object" &&
      typeof maybeIntent.confidence === "number"
    ) {
      primaryConfidences.push(maybeIntent.confidence);
    }

    entries.push({
      fixtureId: fx.id,
      fixtureHash: hashFixture(fx),
      aiOutput,
      matcherResults,
      passed,
      modelId: opts.modelId,
      providerName: opts.providerName,
      timestamp: generatedAt,
    });
  }

  const strictPass = entries.filter((e) => e.passed).length;
  const report: RunReport<TOutput> = {
    scenario: opts.scenario,
    generatedAt,
    modelId: opts.modelId,
    providerName: opts.providerName,
    fixtures: entries,
    summary: {
      total: entries.length,
      strictPass,
      strictFail: entries.length - strictPass,
      skipped: 0,
      ...(primaryConfidences.length > 0
        ? {
            avgPrimaryConfidence:
              primaryConfidences.reduce((a, b) => a + b, 0) / primaryConfidences.length,
          }
        : {}),
    },
  };

  const diff = priorBaseline ? compareToBaseline(report, priorBaseline) : undefined;
  if (diff) report.diff = diff;

  // Spec 69 §9.2 baseline-write rules:
  //   forceRefresh → always write (caller explicitly accepts current state as truth)
  //   refresh + no strict failures + (no prior baseline OR no regression) → write
  //   anything else → never write
  // The `strictFail === 0` guard prevents a first --refresh-baseline run with
  // matcher failures from committing a broken baseline as the replay source
  // (Codex R5-P2). forceRefresh bypasses this — the operator's job to verify.
  const shouldRefresh =
    opts.live &&
    (opts.forceRefreshBaseline ||
      (opts.refreshBaseline === true && report.summary.strictFail === 0 && !diff?.hasRegression));
  if (shouldRefresh) {
    await writeCanonicalBaseline({
      scenario: opts.scenario,
      report,
      baselinesDir: opts.baselinesDir,
      writeDatedArchive: true,
    });
  }

  // Spec §9.4: live runs must fail on strict matcher failures even
  // without a prior baseline. Diff-based regression detection is for
  // AFTER the first baseline is established; before that, the absolute
  // strictFail count is the only gate.
  //
  // Replay mode is intentionally excluded: replay re-runs matchers
  // against recorded outputs, so failures there indicate matcher-schema
  // drift, which the `bun test` matcher suite catches separately
  // (spec §9.1). Throwing here would double-gate that case.
  //
  // RegressionError takes precedence when applicable — it carries
  // strictly more diagnostic info (transitions, deltaPp) than the
  // absolute-floor EvalFailureError, and any regression already implies
  // strictFail > 0.
  if (diff?.hasRegression) {
    throw new RegressionError(diff);
  }

  if (opts.live && report.summary.strictFail > 0) {
    throw new EvalFailureError<TOutput>(report);
  }

  return report;
}

// ── Fixture loader ──────────────────────────────────────────

export async function loadFixtures<TInput = unknown, TContext = unknown>(opts: {
  fixturesDir: string;
  scenario: string;
  fixtureFilter?: string;
  tagFilter?: string[];
}): Promise<EvalFixture<TInput, TContext>[]> {
  const files = await collectJsonFiles(opts.fixturesDir);
  const fixtures: EvalFixture<TInput, TContext>[] = [];
  for (const file of files) {
    const raw = await readFile(file, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `loadFixtures: ${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!isEvalFixture(parsed)) {
      throw new Error(`loadFixtures: ${file} does not match EvalFixture shape`);
    }
    if (parsed.scenario !== opts.scenario) continue;
    if (opts.fixtureFilter && parsed.id !== opts.fixtureFilter) continue;
    if (opts.tagFilter && opts.tagFilter.length > 0) {
      const missing = opts.tagFilter.filter((t) => !parsed.tags.includes(t));
      if (missing.length > 0) continue;
    }
    fixtures.push(parsed as EvalFixture<TInput, TContext>);
  }
  // Stable order — fixture id is unique per spec 69 §4.1.
  fixtures.sort((a, b) => a.id.localeCompare(b.id));
  return fixtures;
}

// ── Cost estimation ─────────────────────────────────────────

export function estimateCost(
  fixtures: EvalFixture[],
  modelId: string,
): { totalUsd: number; perFixtureUsd: number; pricingMatched: boolean } {
  const pricing = resolvePricing(modelId);
  let total = 0;
  for (const fx of fixtures) {
    const inTok = fx.meta?.estimatedTokens?.input ?? DEFAULT_INPUT_TOKENS;
    const outTok = fx.meta?.estimatedTokens?.output ?? DEFAULT_OUTPUT_TOKENS;
    total += (inTok / 1_000_000) * pricing.input;
    total += (outTok / 1_000_000) * pricing.output;
  }
  const per = fixtures.length === 0 ? 0 : total / fixtures.length;
  return { totalUsd: total, perFixtureUsd: per, pricingMatched: pricing.matched };
}

// ── helpers ─────────────────────────────────────────────

function invokeMatchers<TOutput>(
  fx: EvalFixture,
  aiOutput: TOutput,
  registry: MatcherRegistry,
): MatcherResult[] {
  const results: MatcherResult[] = [];
  for (const invocation of fx.expected.matchers) {
    results.push((registry as MatcherRegistry<TOutput>).invoke(invocation, aiOutput));
  }
  return results;
}

async function runLiveSafely<TOutput>(
  adapter: { runLive: (fx: EvalFixture, deps: unknown) => Promise<unknown> },
  fx: EvalFixture,
  deps: unknown,
): Promise<TOutput> {
  // Bubble adapter errors verbatim — the runner caller decides whether to
  // halt the run or continue. Wrapping here would obscure stack traces.
  return (await adapter.runLive(fx, deps)) as TOutput;
}

async function collectJsonFiles(root: string): Promise<string[]> {
  const stats = await stat(root).catch(() => null);
  if (!stats) {
    throw new Error(`loadFixtures: fixturesDir not found: ${root}`);
  }
  if (stats.isFile()) {
    return root.endsWith(".json") ? [root] : [];
  }
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        out.push(full);
      }
    }
  }
  await walk(root);
  out.sort();
  return out;
}

function isEvalFixture(value: unknown): value is EvalFixture {
  if (value === null || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  if (typeof o.id !== "string") return false;
  if (typeof o.scenario !== "string") return false;
  if (!Array.isArray(o.tags) || !o.tags.every((t) => typeof t === "string")) return false;
  if (typeof o.description !== "string") return false;
  if (!("input" in o)) return false;
  if (o.expected === null || typeof o.expected !== "object") return false;
  const expected = o.expected as { matchers?: unknown };
  if (!Array.isArray(expected.matchers)) return false;
  for (const m of expected.matchers) {
    if (m === null || typeof m !== "object") return false;
    const mObj = m as Record<string, unknown>;
    if (typeof mObj.name !== "string") return false;
    if (mObj.args === null || typeof mObj.args !== "object" || Array.isArray(mObj.args)) {
      return false;
    }
  }
  return true;
}

function defaultCostPrinter(msg: string): void {
  // Spec 69 §8.1 requires every live run prints its cost banner.
  // stderr keeps stdout reserved for the report/diff output.
  process.stderr.write(`${msg}\n`);
}
