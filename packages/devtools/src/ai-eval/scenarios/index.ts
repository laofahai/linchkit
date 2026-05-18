/**
 * Scenario barrel — registry primitives only.
 *
 * Concrete scenario adapters (e.g. the intent adapter) live in their
 * owning capability package — devtools must not import from `addons/`,
 * and an eval scenario must call the production code it evaluates.
 * See `addons/ai-provider/cap-ai-provider/src/eval/intent-scenario.ts`.
 */

export { createScenarioRegistry, type ScenarioAdapter, type ScenarioRegistry } from "./registry";
