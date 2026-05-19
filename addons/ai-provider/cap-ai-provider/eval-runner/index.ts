/**
 * AI eval barrel — capability-side scenario adapters.
 *
 * Re-exports the intent scenario so downstream entry scripts (the bin
 * launcher under `bin/`, or any custom CLI) can register it into a
 * `ScenarioRegistry` without reaching into the file tree.
 */

export {
  createIntentScenario,
  type IntentScenarioAdapter,
  type IntentScenarioDeps,
} from "./intent-scenario";
