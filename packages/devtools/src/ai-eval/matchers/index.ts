/**
 * Matcher barrel — registry + per-scenario matcher catalogs.
 */

export { anomalyMatchers, registerAnomalyMatchers } from "./anomaly";
export { intentMatchers, registerIntentMatchers } from "./intent";
export { patternMatchers, registerPatternMatchers } from "./pattern";
export { createMatcherRegistry, type MatcherRegistry } from "./registry";
export { registerWatcherMatchers, watcherMatchers } from "./watcher";
