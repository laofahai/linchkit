/**
 * @linchkit/devtools/ai-eval — AI Evaluation Framework public surface.
 *
 * See `docs/specs/69_ai_evaluation_framework.md`.
 *
 * Phase 1 ships: fixture / matcher types, intent matcher catalog,
 * scenario adapters + registry, runner, baseline I/O + diff, and
 * Markdown / JSON reporters. The CLI entrypoint arrives in Checkpoint 3.
 */

export {
  type BaselineLayoutOptions,
  canonicalPath,
  compareToBaseline,
  DEFAULT_BASELINES_DIR,
  datedArchivePath,
  hashFixture,
  type LoadBaselineOptions,
  loadCanonicalBaseline,
  RUNNER_VERSION,
  reportToBaselineFile,
  type WriteBaselineOptions,
  writeCanonicalBaseline,
} from "./baseline";
export { type CliDeps, type CliRunResult, runCli } from "./cli";
export { intentMatchers, registerIntentMatchers } from "./matchers/intent";
export { createMatcherRegistry, type MatcherRegistry } from "./matchers/registry";
export { type MarkdownReportOptions, renderJsonReport, renderMarkdownReport } from "./reporters";
export {
  estimateCost,
  loadFixtures,
  RegressionError,
  type RunDeps,
  type RunOptions,
  runEval,
} from "./runner";
export {
  createIntentScenario,
  createScenarioRegistry,
  type InlineCatalogAction,
  type IntentFixtureContext,
  type IntentFixtureInput,
  type IntentScenarioAdapter,
  type IntentScenarioDeps,
  type OntologyRegistryLike,
  type ScenarioAdapter,
  type ScenarioRegistry,
} from "./scenarios";
export type {
  BaselineDiff,
  BaselineFile,
  BaselineFixtureEntry,
  EvalFixture,
  IntentEvalOutput,
  MatcherFn,
  MatcherInvocation,
  MatcherResult,
  RunReport,
} from "./types";
