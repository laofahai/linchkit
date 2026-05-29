/**
 * AI Evaluation Framework — internal barrel re-exported from the root
 * `@linchkit/devtools` package surface. This module is NOT exposed as a
 * separate `./ai-eval` subpath in package.json; consumers import everything
 * via `import { ... } from "@linchkit/devtools"` (see `../index.ts`).
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
export { type CliDeps, type CliRunResult, type LoadLiveDepsResult, runCli } from "./cli";
export { anomalyMatchers, registerAnomalyMatchers } from "./matchers/anomaly";
export { intentMatchers, registerIntentMatchers } from "./matchers/intent";
export { patternMatchers, registerPatternMatchers } from "./matchers/pattern";
export { createMatcherRegistry, type MatcherRegistry } from "./matchers/registry";
export { registerWatcherMatchers, watcherMatchers } from "./matchers/watcher";
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
  AnomalyEvalOutput,
  AnomalyEvalOutputItem,
  AnomalyFixtureContext,
  AnomalyFixtureInput,
  AnomalyUsageEventInput,
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
  PatternEvalOutput,
  PatternEvalOutputItem,
  PatternExecLogInput,
  PatternFixtureContext,
  PatternFixtureInput,
  RunReport,
  WatcherDefInput,
  WatcherEvalOutput,
  WatcherEvalOutputItem,
  WatcherFixtureContext,
  WatcherFixtureInput,
  WatcherScheduleTriggerInput,
  WatcherSetChangeTriggerInput,
  WatcherStalenessTriggerInput,
  WatcherThresholdTriggerInput,
  WatcherTriggerInput,
} from "./types";
