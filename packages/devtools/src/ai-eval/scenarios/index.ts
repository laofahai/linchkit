/**
 * Scenario barrel — adapter factories + registry.
 */

export type {
  InlineCatalogAction,
  IntentFixtureContext,
  IntentFixtureInput,
  IntentScenarioAdapter,
  IntentScenarioDeps,
  OntologyRegistryLike,
} from "./intent";
export { createIntentScenario } from "./intent";
export { createScenarioRegistry, type ScenarioAdapter, type ScenarioRegistry } from "./registry";
