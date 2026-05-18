/**
 * AI Evaluation Framework — public type definitions.
 *
 * Implements the fixture / matcher contracts from
 * `docs/specs/69_ai_evaluation_framework.md` §4 + §5.
 *
 * These types are scenario-neutral. Scenario-specific output shapes
 * (e.g. `IntentEvalOutput`) live here too so that `packages/devtools`
 * does not depend on any `addons/` capability package — the scenario
 * adapter that converts `cap-ai-provider`'s `ActionProposal` to
 * `IntentEvalOutput` is added in a later phase.
 */

/**
 * A single AI evaluation fixture.
 *
 * Fixtures are normally authored as JSON under
 * `__tests__/eval/fixtures/<scenario>/<tag>/<id>.json` and consumed by
 * the runner (added in a later phase). The generic parameters let
 * scenario authors narrow `input` / `context` once an adapter is in
 * place; runners that load fixtures from disk default to `unknown`.
 */
export interface EvalFixture<TInput = unknown, TContext = unknown> {
  /** Stable, unique identifier — used as filename stem and report key. */
  id: string;
  /** Scenario name — must match a registered scenario in the runner. */
  scenario: string;
  /** Free-form tags for slicing reports (e.g. "happy_path", "injection"). */
  tags: string[];
  /** Human-readable purpose. Surfaces in failure reports. */
  description: string;
  /** Scenario-specific input. */
  input: TInput;
  /** Optional context (catalog selector, prior records, time-of-day, etc.). */
  context?: TContext;
  /** Assertions evaluated against the AI output. */
  expected: {
    matchers: MatcherInvocation[];
  };
  /** Optional metadata for cost tracking and reporting. */
  meta?: {
    estimatedTokens?: { input: number; output: number };
    notes?: string;
  };
}

/**
 * A single matcher call inside a fixture's `expected.matchers` list.
 */
export interface MatcherInvocation {
  /** Matcher name (e.g. "action_equals"). */
  name: string;
  /** Matcher-specific arguments. */
  args: Record<string, unknown>;
  /** Default: true. When false, the matcher contributes to scored metrics but does not gate the fixture. */
  strict?: boolean;
}

/**
 * Outcome of invoking a single matcher against an AI output.
 */
export interface MatcherResult {
  /** Matcher name (mirrors `MatcherInvocation.name`). */
  matcher: string;
  /** Whether the assertion held. */
  passed: boolean;
  /** Echoes the `strict` value from the invocation (defaulted to true). */
  strict: boolean;
  /** What the matcher actually saw — used by reports for explainability. */
  observed?: unknown;
  /** Human-readable failure reason. Omitted on pass. */
  message?: string;
}

/**
 * Signature every matcher implementation conforms to.
 *
 * Matchers MUST NOT throw — they return a failing `MatcherResult`
 * instead, so the runner can record the failure without aborting the
 * whole fixture batch. The registry wraps any accidental throw into a
 * failing result as a safety net.
 */
export type MatcherFn<TOutput = unknown> = (
  output: TOutput,
  args: Record<string, unknown>,
) => MatcherResult;

/**
 * Scenario-neutral shape consumed by intent-scenario matchers.
 *
 * A later scenario adapter is responsible for converting
 * `cap-ai-provider`'s `ActionProposal` (and its `alternatives`) to this
 * shape. Defining it here keeps the matcher module free of `addons/`
 * imports per the module-boundary rule in the root CLAUDE.md.
 */
export interface IntentEvalOutput {
  /** Top-level action name, or `null` when the resolver refused. */
  action: string | null;
  /** Cleaned action input. */
  input: Record<string, unknown>;
  /** Primary proposal confidence in [0, 1]. */
  confidence: number;
  /** Required input fields the resolver could not fill. */
  missingFields: string[];
  /** Free-form explanation surfaced to the user. */
  explanation: string;
  /** Optional alternative proposals (same shape, no nested alternatives in practice). */
  alternatives?: IntentEvalOutput[];
  /** Single-call latency in milliseconds. May be `undefined` for replayed outputs. */
  latencyMs?: number;
}
