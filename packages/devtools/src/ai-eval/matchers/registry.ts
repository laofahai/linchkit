/**
 * Matcher registry — per-scenario name → matcher map.
 *
 * Each scenario (intent, anomaly, pattern, watcher) instantiates its
 * own registry parameterised by its output shape. Cross-scenario
 * matchers (latency, cost) are registered by callers; the registry
 * itself is scenario-agnostic.
 */

import type { MatcherFn, MatcherInvocation, MatcherResult } from "../types";

export interface MatcherRegistry<TOutput = unknown> {
  /** Register a matcher under `name`. Throws when `name` is already registered. */
  register(name: string, fn: MatcherFn<TOutput>): void;
  /** Look up a matcher by name. */
  get(name: string): MatcherFn<TOutput> | undefined;
  /** Names of every registered matcher. */
  list(): string[];
  /** Invoke a matcher and return its result. Never throws. */
  invoke(invocation: MatcherInvocation, output: TOutput): MatcherResult;
}

export function createMatcherRegistry<TOutput = unknown>(): MatcherRegistry<TOutput> {
  const matchers = new Map<string, MatcherFn<TOutput>>();

  return {
    register(name, fn) {
      if (matchers.has(name)) {
        throw new Error(`matcher already registered: ${name}`);
      }
      matchers.set(name, fn);
    },

    get(name) {
      return matchers.get(name);
    },

    list() {
      return Array.from(matchers.keys());
    },

    invoke(invocation, output) {
      const strict = invocation.strict ?? true;
      const fn = matchers.get(invocation.name);
      if (!fn) {
        return {
          matcher: invocation.name,
          passed: false,
          strict,
          message: `unknown matcher: ${invocation.name}`,
        };
      }

      try {
        const result = fn(output, invocation.args);
        // Force the invocation-level strict flag to win over whatever the matcher returned —
        // matchers default to `strict: true` but the fixture's invocation is authoritative.
        return { ...result, strict };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          matcher: invocation.name,
          passed: false,
          strict,
          message,
        };
      }
    },
  };
}
