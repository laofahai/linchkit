/**
 * Canonical baseline I/O + diff math.
 *
 * Implements spec 69 §7.2 (JSON snapshot layout), §9.2 (write rules) and
 * the diff structure consumed by §9.4 regression gating.
 *
 * Layout (relative to repo root):
 *   __tests__/eval/baselines/<scenario>.current.json     ← canonical replay source
 *   __tests__/eval/baselines/<scenario>/<YYYY-MM-DD>.json ← dated archive
 *
 * The runner orchestrates WHEN to call writeCanonicalBaseline. This
 * module is purely the storage + diff primitive.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  BaselineDiff,
  BaselineFile,
  BaselineFixtureEntry,
  EvalFixture,
  MatcherResult,
  RunReport,
} from "./types";

/**
 * Look up the recorded entry for a fixture in a loaded baseline.
 *
 * Fail-loud per spec §6.4 when any of the following hold:
 *  - `baseline` is `null` (no canonical snapshot loaded at all);
 *  - the fixture id has no entry in the baseline (drift / unrecorded fixture);
 *  - the fixture's current hash differs from the recorded hash (the fixture's
 *    `input` or `context` changed since the baseline was written, so the
 *    recorded `aiOutput` no longer corresponds to the live fixture shape).
 *
 * All thrown errors instruct the operator to refresh the baseline via
 * `AI_EVAL_LIVE=1 ... --refresh-baseline`, matching the spec's wording.
 *
 * Centralising this in baseline.ts (rather than inside each scenario adapter)
 * guarantees every scenario observes the same fail-loud semantics — and that
 * the P2 hash-drift check cannot be silently omitted by a new adapter.
 */
export function findBaselineEntry<TOutput = unknown>(
  fx: EvalFixture,
  baseline: BaselineFile<TOutput> | null,
): BaselineFixtureEntry<TOutput> {
  if (!baseline) {
    throw new Error(
      `ai-eval replay: cannot replay fixture "${fx.id}" — no canonical baseline loaded. ` +
        "Run with AI_EVAL_LIVE=1 ... --refresh-baseline to produce one.",
    );
  }
  const entry = baseline.fixtures.find((e) => e.fixtureId === fx.id);
  if (!entry) {
    throw new Error(
      `ai-eval replay: fixture "${fx.id}" has no recorded AI output in canonical baseline. ` +
        "Run with AI_EVAL_LIVE=1 ... --refresh-baseline to record one.",
    );
  }
  const currentHash = hashFixture(fx);
  if (entry.fixtureHash !== currentHash) {
    throw new Error(
      `ai-eval replay: fixture "${fx.id}" hash drift — fixture input/context changed since baseline was written ` +
        `(baseline ${entry.fixtureHash.slice(0, 12)}…, current ${currentHash.slice(0, 12)}…). ` +
        "Run with AI_EVAL_LIVE=1 ... --refresh-baseline to re-record this fixture.",
    );
  }
  return entry;
}

/** Default repo-relative directory holding all baselines. */
export const DEFAULT_BASELINES_DIR = "__tests__/eval/baselines";

/**
 * Regression hit-rate floor: any drop greater than (or equal to) this many
 * percentage points marks the diff as a regression even without a per-fixture
 * pass-to-fail transition. Matches spec 69 §9.4 "> 10pp drop".
 */
const REGRESSION_DELTA_PP = -10;

export interface BaselineLayoutOptions {
  /** Override the canonical baselines root. Default: `DEFAULT_BASELINES_DIR`. */
  baselinesDir?: string;
}

export interface LoadBaselineOptions extends BaselineLayoutOptions {
  scenario: string;
  /** When true (default), missing canonical files resolve to `null`. */
  optional?: boolean;
}

export interface WriteBaselineOptions<TOutput = unknown> extends BaselineLayoutOptions {
  scenario: string;
  report: RunReport<TOutput>;
  /**
   * When true, also writes the dated archive alongside the canonical file.
   * Spec 69 §9.2 keeps both in sync on a successful refresh.
   */
  writeDatedArchive?: boolean;
}

/** Resolve the canonical file path: `<baselinesDir>/<scenario>.current.json`. */
export function canonicalPath(scenario: string, baselinesDir = DEFAULT_BASELINES_DIR): string {
  return path.join(baselinesDir, `${scenario}.current.json`);
}

/** Resolve a dated archive path: `<baselinesDir>/<scenario>/<YYYY-MM-DD>.json`. */
export function datedArchivePath(
  scenario: string,
  date: Date,
  baselinesDir = DEFAULT_BASELINES_DIR,
): string {
  return path.join(baselinesDir, scenario, `${formatYmd(date)}.json`);
}

/**
 * Load the canonical baseline for a scenario.
 *
 * Returns `null` when the file does not exist and `optional !== false`.
 * Surfaces parse errors verbatim so callers can fail loud per spec §6.4.
 */
export async function loadCanonicalBaseline<TOutput = unknown>(
  opts: LoadBaselineOptions,
): Promise<BaselineFile<TOutput> | null> {
  const filePath = canonicalPath(opts.scenario, opts.baselinesDir);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if (isFileNotFoundError(err) && opts.optional !== false) {
      return null;
    }
    throw err;
  }
  return JSON.parse(raw) as BaselineFile<TOutput>;
}

/**
 * Write the canonical baseline for a scenario, optionally mirroring to a
 * dated archive. Caller is responsible for enforcing the §9.2 write rules
 * (refresh-baseline + no-regression checks).
 */
export async function writeCanonicalBaseline<TOutput = unknown>(
  opts: WriteBaselineOptions<TOutput>,
): Promise<{ canonicalPath: string; datedPath?: string }> {
  const baselinesDir = opts.baselinesDir ?? DEFAULT_BASELINES_DIR;
  const file: BaselineFile<TOutput> = reportToBaselineFile(opts.report);

  const canonical = canonicalPath(opts.scenario, baselinesDir);
  await mkdir(path.dirname(canonical), { recursive: true });
  await writeFile(canonical, `${JSON.stringify(file, null, 2)}\n`, "utf8");

  let dated: string | undefined;
  if (opts.writeDatedArchive) {
    dated = datedArchivePath(opts.scenario, new Date(file.generatedAt), baselinesDir);
    await mkdir(path.dirname(dated), { recursive: true });
    await writeFile(dated, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  }

  return { canonicalPath: canonical, datedPath: dated };
}

/** Build a `BaselineFile` from an in-memory `RunReport`. */
export function reportToBaselineFile<TOutput = unknown>(
  report: RunReport<TOutput>,
): BaselineFile<TOutput> {
  return {
    scenario: report.scenario,
    generatedAt: report.generatedAt,
    runnerVersion: RUNNER_VERSION,
    modelId: report.modelId,
    providerName: report.providerName,
    fixtures: report.fixtures,
  };
}

/**
 * Compare a current run against a prior canonical baseline.
 *
 * Pass/fail per fixture is taken from `BaselineFixtureEntry.passed`. Newly
 * failing matcher names are reported alongside newly passing ones to give
 * reviewers an at-a-glance story.
 */
export function compareToBaseline<TOutput = unknown>(
  current: RunReport<TOutput>,
  prior: BaselineFile<TOutput>,
): BaselineDiff {
  const priorByFixture = new Map<string, BaselineFixtureEntry<TOutput>>();
  for (const entry of prior.fixtures) {
    priorByFixture.set(entry.fixtureId, entry);
  }

  const byFixture: BaselineDiff["byFixture"] = [];
  let priorPass = 0;
  let currentPass = 0;
  let regressions = 0;

  for (const cur of current.fixtures) {
    if (cur.passed) currentPass += 1;
    const prev = priorByFixture.get(cur.fixtureId);
    if (!prev) {
      // New fixture has no prior to diff against — treat as pass-to-pass / fail-to-fail
      // to avoid spurious regressions. New fixtures are surfaced by the
      // "first-ever live run writes canonical" path in the runner.
      const change = cur.passed ? "pass-to-pass" : "fail-to-fail";
      byFixture.push({
        fixtureId: cur.fixtureId,
        change,
        diff: { newlyFailing: [], newlyPassing: [] },
      });
      continue;
    }
    if (prev.passed) priorPass += 1;

    const change = diffStatus(prev.passed, cur.passed);
    if (change === "pass-to-fail") regressions += 1;

    byFixture.push({
      fixtureId: cur.fixtureId,
      change,
      diff: matcherDelta(prev.matcherResults, cur.matcherResults),
    });
  }

  // Fixtures present in the prior baseline but missing from the current run
  // are ignored for hit-rate math (the runner may have been invoked with a
  // filter). Regression gating only fires on entries that exist in both.
  const priorTotal = current.fixtures.filter((cur) => priorByFixture.has(cur.fixtureId)).length;
  const priorPct = priorTotal > 0 ? (priorPass / priorTotal) * 100 : 0;
  const currentPct = priorTotal > 0 ? (currentPass / priorTotal) * 100 : 0;
  const deltaPp = currentPct - priorPct;

  const hasRegression = regressions > 0 || deltaPp <= REGRESSION_DELTA_PP;

  return {
    scenario: current.scenario,
    baselineGeneratedAt: prior.generatedAt,
    current: { generatedAt: current.generatedAt, modelId: current.modelId },
    byFixture,
    summary: {
      priorPass,
      currentPass,
      delta: currentPass - priorPass,
      regressions,
      deltaPp,
    },
    hasRegression,
  };
}

/**
 * Stable SHA-256 of a fixture's input + context. Uses Bun's CryptoHasher
 * so we don't pull in Node's `crypto` async APIs unnecessarily.
 */
export function hashFixture(fx: EvalFixture): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(canonicalJson({ input: fx.input, context: fx.context ?? null }));
  return hasher.digest("hex");
}

/**
 * Deterministic JSON: object keys sorted lexicographically at every level.
 * Arrays preserve order. Used by hashFixture and any other consumer that
 * needs the same bytes for equivalent values regardless of key insertion.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

// ── helpers ─────────────────────────────────────────────

function stableValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stableValue);
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    out[key] = stableValue(obj[key]);
  }
  return out;
}

function diffStatus(
  prevPassed: boolean,
  curPassed: boolean,
): "pass-to-pass" | "pass-to-fail" | "fail-to-pass" | "fail-to-fail" {
  if (prevPassed && curPassed) return "pass-to-pass";
  if (prevPassed && !curPassed) return "pass-to-fail";
  if (!prevPassed && curPassed) return "fail-to-pass";
  return "fail-to-fail";
}

function matcherDelta(
  prev: MatcherResult[],
  cur: MatcherResult[],
): { newlyFailing: string[]; newlyPassing: string[] } {
  const prevStrictFailed = new Set(prev.filter((r) => r.strict && !r.passed).map((r) => r.matcher));
  const curStrictFailed = new Set(cur.filter((r) => r.strict && !r.passed).map((r) => r.matcher));

  const newlyFailing: string[] = [];
  for (const name of curStrictFailed) {
    if (!prevStrictFailed.has(name)) newlyFailing.push(name);
  }
  const newlyPassing: string[] = [];
  for (const name of prevStrictFailed) {
    if (!curStrictFailed.has(name)) newlyPassing.push(name);
  }
  return { newlyFailing, newlyPassing };
}

function formatYmd(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function isFileNotFoundError(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return code === "ENOENT";
}

/**
 * Stamped into every written baseline. C3 may switch this to read from
 * `package.json` once the CLI lands; hard-coded here keeps devtools
 * standalone and avoids JSON-import gymnastics at runtime.
 */
export const RUNNER_VERSION = "ai-eval/0.1.0";
