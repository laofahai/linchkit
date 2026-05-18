/**
 * @linchkit/devtools/ai-eval — AI Evaluation Framework public surface.
 *
 * See `docs/specs/69_ai_evaluation_framework.md`.
 *
 * Phase 1 ships: fixture / matcher types, intent matcher catalog, the
 * generic scenario registry, runner, baseline I/O + diff, Markdown / JSON
 * reporters, and CLI entrypoint. Concrete scenario adapters live in
 * their owning capability package (e.g. the intent adapter ships from
 * `@linchkit/cap-ai-provider`).
 */

export {
  type BaselineLayoutOptions,
  canonicalPath,
  compareToBaseline,
  DEFAULT_BASELINES_DIR,
  datedArchivePath,
  findBaselineEntry,
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
  EvalFailureError,
  estimateCost,
  loadFixtures,
  RegressionError,
  type RunDeps,
  type RunOptions,
  runEval,
} from "./runner";
export {
  createScenarioRegistry,
  type ScenarioAdapter,
  type ScenarioRegistry,
} from "./scenarios";
export type {
  BaselineDiff,
  BaselineFile,
  BaselineFixtureEntry,
  EvalFixture,
  InlineCatalogAction,
  IntentEvalOutput,
  IntentFixtureContext,
  IntentFixtureInput,
  MatcherFn,
  MatcherInvocation,
  MatcherResult,
  OntologyRegistryLike,
  RunReport,
} from "./types";
