/**
 * @linchkit/devtools/ai-eval — AI Evaluation Framework public surface.
 *
 * See `docs/specs/69_ai_evaluation_framework.md`.
 *
 * Phase 1 deliverables in this barrel: fixture / matcher types, the
 * scenario-neutral intent output shape, the matcher registry, and the
 * intent matcher catalog. Runner, scenario adapters, reporters, and
 * CLI ship in later phases.
 */

export { intentMatchers, registerIntentMatchers } from "./matchers/intent";
export { createMatcherRegistry, type MatcherRegistry } from "./matchers/registry";
export type {
  EvalFixture,
  IntentEvalOutput,
  MatcherFn,
  MatcherInvocation,
  MatcherResult,
} from "./types";
