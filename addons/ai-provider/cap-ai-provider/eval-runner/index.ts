/**
 * AI eval barrel — capability-side scenario adapters.
 *
 * Re-exports the intent scenario so downstream entry scripts (the bin
 * launcher under `bin/`, or any custom CLI) can register it into a
 * `ScenarioRegistry` without reaching into the file tree.
 */

export {
  type AnomalyDetectorScenarioAdapter,
  createAnomalyDetectorScenario,
} from "./anomaly-detector-scenario";
export {
  createIntentScenario,
  type IntentScenarioAdapter,
  type IntentScenarioDeps,
} from "./intent-scenario";
export {
  createPatternDetectorScenario,
  type PatternDetectorScenarioAdapter,
} from "./pattern-detector-scenario";
export {
  createWatcherEngineScenario,
  type WatcherEngineScenarioAdapter,
} from "./watcher-engine-scenario";
