/**
 * Watcher-engine scenario matchers — Spec 69 Phase 4.
 */

import type { MatcherFn, MatcherResult, WatcherEvalOutput, WatcherEvalOutputItem } from "../types";
import type { MatcherRegistry } from "./registry";

function fail(matcher: string, message: string, observed?: unknown): MatcherResult {
  return { matcher, passed: false, strict: true, observed, message };
}
function pass(matcher: string, observed?: unknown): MatcherResult {
  return { matcher, passed: true, strict: true, observed };
}

/** Assert exact number of watchers that fired. */
const watcher_fire_count: MatcherFn<WatcherEvalOutput> = (output, args) => {
  if (typeof args.value !== "number")
    return fail("watcher_fire_count", "arg 'value' must be a number");
  const fired = output.filter((w: WatcherEvalOutputItem) => w.fired).length;
  if (fired === args.value) return pass("watcher_fire_count", fired);
  return fail(
    "watcher_fire_count",
    `expected ${args.value} watcher(s) to fire, got ${fired}`,
    fired,
  );
};

/** Assert that a specific watcher fired. */
const watcher_fired: MatcherFn<WatcherEvalOutput> = (output, args) => {
  if (typeof args.watcherName !== "string")
    return fail("watcher_fired", "arg 'watcherName' must be a string");
  const entry = output.find((w: WatcherEvalOutputItem) => w.watcherName === args.watcherName);
  if (!entry) return fail("watcher_fired", `watcher "${args.watcherName}" not found in results`);
  if (entry.fired) return pass("watcher_fired", args.watcherName);
  return fail(
    "watcher_fired",
    `watcher "${args.watcherName}" did not fire: ${entry.reason ?? "unknown reason"}`,
  );
};

/** Assert that a specific watcher did NOT fire. */
const watcher_not_fired: MatcherFn<WatcherEvalOutput> = (output, args) => {
  if (typeof args.watcherName !== "string")
    return fail("watcher_not_fired", "arg 'watcherName' must be a string");
  const entry = output.find((w: WatcherEvalOutputItem) => w.watcherName === args.watcherName);
  if (!entry) return pass("watcher_not_fired");
  if (!entry.fired) return pass("watcher_not_fired");
  return fail(
    "watcher_not_fired",
    `watcher "${args.watcherName}" fired but was expected not to`,
  );
};

/** Assert that no watchers fired. */
const no_watchers_fired: MatcherFn<WatcherEvalOutput> = (output, _args) => {
  const fired = output.filter((w: WatcherEvalOutputItem) => w.fired);
  if (fired.length === 0) return pass("no_watchers_fired");
  return fail(
    "no_watchers_fired",
    `expected no watchers to fire, but ${fired.map((w: WatcherEvalOutputItem) => w.watcherName).join(", ")} fired`,
  );
};

export const watcherMatchers: Record<string, MatcherFn<WatcherEvalOutput>> = {
  watcher_fire_count,
  watcher_fired,
  watcher_not_fired,
  no_watchers_fired,
};

export function registerWatcherMatchers(registry: MatcherRegistry): void {
  for (const [name, fn] of Object.entries(watcherMatchers)) {
    registry.register(name, fn as MatcherFn);
  }
}
