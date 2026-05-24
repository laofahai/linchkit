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
 * Per-fixture input for the intent scenario.
 *
 * The shape is defined here (not inside a scenario adapter) so fixture
 * JSON files committed to disk have a single canonical schema and
 * downstream packages can author fixtures without depending on the
 * scenario adapter implementation.
 */
export interface IntentFixtureInput {
  /** Natural-language message handed to the resolver. */
  userMessage: string;
}

/**
 * Per-fixture context for the intent scenario.
 *
 * `catalogSource` selects which action catalog the scenario evaluates against:
 *  - `inline:<name>` — the scenario adapter requests the catalog by name
 *    via its `loadInlineCatalog` dep (the bin wires it to disk JSON).
 *  - `demo:<capName>` — the scenario adapter falls back to the live
 *    OntologyRegistry exposed in deps (used when fixtures depend on the
 *    runtime-discovered action surface).
 *
 * `scope` narrows the resolved catalog before the AI call.
 */
export interface IntentFixtureContext {
  catalogSource: string;
  scope?: { entityFilter?: string[]; actionFilter?: string[] };
}

/**
 * Single entry returned by an inline catalog loader.
 *
 * The shape is intentionally a structural subset of `ActionDefinition`
 * from `@linchkit/core` — fixture authors only need the fields the
 * intent-resolver reads (name/entity/label/description/input/ai.promptHints).
 * The scenario adapter coerces these to the production `ActionDefinition`
 * shape at its boundary.
 */
export interface InlineCatalogAction {
  name: string;
  entity: string;
  label: string;
  description?: string;
  input?: Record<
    string,
    {
      type: string;
      required?: boolean;
      label?: string;
      description?: string;
      allowEmpty?: boolean;
    }
  >;
}

/**
 * Minimal `OntologyRegistry` surface used by the intent scenario in
 * `demo:*` mode. Mirrors `OntologyRegistryLike` from
 * `addons/ai-provider/cap-ai-provider` but kept here as the structurally
 * weaker public shape that fixture/test code can construct without
 * importing addon-side types. The scenario adapter at the addon boundary
 * is responsible for satisfying the stricter production type that
 * `resolveIntent` consumes.
 */
export interface OntologyRegistryLike {
  listEntities(): string[];
  actionsFor(
    entityName: string,
  ): ReadonlyArray<InlineCatalogAction & { ai?: { promptHints?: string[] } }>;
}

/**
 * Scenario-neutral shape consumed by intent-scenario matchers.
 *
 * A scenario adapter (in `cap-ai-provider`) is responsible for converting
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

// ── Runner / baseline / report types (spec 69 §6.3, §7.2, §9.2) ──

/**
 * Per-fixture outcome captured in both `RunReport` and the committed
 * baseline JSON. Spec 69 §7.2 / §9.2 require the canonical baseline and
 * dated archives to share this shape.
 */
export interface BaselineFixtureEntry<TOutput = unknown> {
  /** Mirrors `EvalFixture.id` — primary key inside a baseline file. */
  fixtureId: string;
  /**
   * SHA-256 of canonical-JSON(fixture.input + fixture.context). Lets the
   * replay path detect drift between the fixture on disk and the
   * recorded `aiOutput`, enforcing spec 69 §6.4 fail-loud behaviour.
   */
  fixtureHash: string;
  /** Recorded AI output for this fixture. */
  aiOutput: TOutput;
  /** Matcher invocation results, in fixture order. */
  matcherResults: MatcherResult[];
  /** True iff every strict matcher passed. */
  passed: boolean;
  /** Model id the AI service reported (optional for replay-only runs). */
  modelId?: string;
  /** Provider name the AI service reported. */
  providerName?: string;
  /** ISO 8601 timestamp the fixture was evaluated. */
  timestamp: string;
}

/** On-disk shape for both `<scenario>.current.json` and dated archives. */
export interface BaselineFile<TOutput = unknown> {
  scenario: string;
  /** ISO 8601 timestamp the baseline was produced. */
  generatedAt: string;
  /** Runner version stamp — useful for invalidating after format changes. */
  runnerVersion: string;
  /** Model id that drove the run that produced this baseline. */
  modelId?: string;
  /** Provider name that produced this baseline. */
  providerName?: string;
  /** Per-fixture entries. Order mirrors the run order. */
  fixtures: BaselineFixtureEntry<TOutput>[];
}

/** Aggregated run report — held in memory and emitted via reporters. */
export interface RunReport<TOutput = unknown> {
  scenario: string;
  generatedAt: string;
  modelId?: string;
  providerName?: string;
  fixtures: BaselineFixtureEntry<TOutput>[];
  summary: {
    total: number;
    strictPass: number;
    strictFail: number;
    skipped: number;
    /** Scenario-specific aggregate; intent uses it for primary confidence. */
    avgPrimaryConfidence?: number;
  };
  /** Populated when a prior canonical baseline existed for diffing. */
  diff?: BaselineDiff;
}

// ── Anomaly Detector scenario types (Spec 69 Phase 4) ──────────────────

/** Serialisable UsageEvent for fixture JSON (timestamps as ISO strings). */
export interface AnomalyUsageEventInput {
  timestamp: string;
  tenantId?: string;
  actorId?: string;
  actionName?: string;
  success: boolean;
  cost?: number;
  tokens?: number;
}

/** Input shape for anomaly-detector eval fixtures. */
export interface AnomalyFixtureInput {
  events: AnomalyUsageEventInput[];
  config?: {
    spikeMultiplier?: number;
    errorRateThreshold?: number;
    minEventsForDetection?: number;
    windowSizeMs?: number;
    repetitiveActionThreshold?: number;
    budgetBurnRateThreshold?: number;
    diverseActionThreshold?: number;
    businessHoursStart?: number;
    businessHoursEnd?: number;
    detectOffHours?: boolean;
  };
}

/** Context shape for anomaly-detector eval fixtures. */
export interface AnomalyFixtureContext {
  now: string;
  tenantId?: string;
  actorId?: string;
}

/** Serialisable representation of a single AnomalyDetection. */
export interface AnomalyEvalOutputItem {
  type: string;
  severity: string;
  description: string;
  tenantId?: string;
  actorId?: string;
  metrics: Record<string, number>;
  thresholds: Record<string, number>;
}

/** Output shape returned by the anomaly-detector scenario adapter. */
export type AnomalyEvalOutput = AnomalyEvalOutputItem[];

// ── Pattern Detector scenario types (Spec 69 Phase 4) ───────────────────

/** Serialisable ExecutionLogEntry for fixture JSON. */
export interface PatternExecLogInput {
  id: string;
  action: string;
  entity?: string;
  capability?: string;
  status: "succeeded" | "failed" | "blocked" | "pending_approval";
  input: Record<string, unknown>;
  tenantId?: string;
  timestamp: string;
  actor: { id: string; type: string };
}

/** Input shape for pattern-detector eval fixtures. */
export interface PatternFixtureInput {
  entries: PatternExecLogInput[];
  config?: {
    minOccurrences?: number;
    minConfidence?: number;
    lookbackDays?: number;
    maxExamples?: number;
    enabledPatterns?: string[];
  };
}

/** Context shape for pattern-detector eval fixtures. */
export interface PatternFixtureContext {
  now?: string;
}

/** Serialisable representation of a single PatternInsight. */
export interface PatternEvalOutputItem {
  id: string;
  type: string;
  entity: string;
  description: string;
  confidence: number;
  evidence: { count: number; timespan: string; examples: unknown[] };
}

/** Output shape returned by the pattern-detector scenario adapter. */
export type PatternEvalOutput = PatternEvalOutputItem[];

// ── Watcher Engine scenario types (Spec 69 Phase 4) ─────────────────────

/** Threshold trigger input (JSON-serialisable). */
export interface WatcherThresholdTriggerInput {
  type: "threshold";
  field?: string;
  condition: { gt?: number; gte?: number; lt?: number; lte?: number; eq?: number };
  debounce?: "once_until_reset" | "once_per_record" | "cooldown";
  cooldownPeriod?: string;
}

/** Staleness trigger input (JSON-serialisable). */
export interface WatcherStalenessTriggerInput {
  type: "staleness";
  field: string;
  threshold: string;
  debounce?: "once_until_reset" | "once_per_record" | "cooldown";
  cooldownPeriod?: string;
}

/** Set-change trigger input (JSON-serialisable). */
export interface WatcherSetChangeTriggerInput {
  type: "set_change";
  on: "added" | "removed" | "modified";
  debounce?: "once_until_reset" | "once_per_record" | "cooldown";
  cooldownPeriod?: string;
}

/** Schedule trigger input (JSON-serialisable). */
export interface WatcherScheduleTriggerInput {
  type: "schedule";
  cron: string;
  debounce?: "once_until_reset" | "once_per_record" | "cooldown";
  cooldownPeriod?: string;
}

export type WatcherTriggerInput =
  | WatcherThresholdTriggerInput
  | WatcherStalenessTriggerInput
  | WatcherSetChangeTriggerInput
  | WatcherScheduleTriggerInput;

/** Serialisable WatcherDefinition for fixture JSON. Maps to core WatcherDefinition. */
export interface WatcherDefInput {
  name: string;
  label?: string;
  enabled?: boolean;
  watch: {
    entity: string;
    filter?: Record<string, unknown>;
  };
  trigger: WatcherTriggerInput;
  effect: { action: string; params?: Record<string, unknown> };
  tenantScoped?: boolean;
}

/** Input shape for watcher-engine eval fixtures. */
export interface WatcherFixtureInput {
  entityName: string;
  record: Record<string, unknown>;
  oldRecord?: Record<string, unknown>;
  watchers: WatcherDefInput[];
}

/** Context shape for watcher-engine eval fixtures. */
export interface WatcherFixtureContext {
  tenantId?: string;
}

/** Serialisable WatcherEvaluationResult. */
export interface WatcherEvalOutputItem {
  watcherName: string;
  fired: boolean;
  reason?: string;
  error?: string;
}

/** Output shape returned by the watcher-engine scenario adapter. */
export type WatcherEvalOutput = WatcherEvalOutputItem[];

// ── Baseline diff ────────────────────────────────────────────────────────

/** Diff between a current `RunReport` and a prior canonical baseline. */
export interface BaselineDiff {
  scenario: string;
  baselineGeneratedAt: string;
  current: { generatedAt: string; modelId?: string };
  byFixture: Array<{
    fixtureId: string;
    change: "pass-to-pass" | "pass-to-fail" | "fail-to-pass" | "fail-to-fail";
    /** Strict-fail matcher delta for explainability. */
    diff: { newlyFailing: string[]; newlyPassing: string[] };
  }>;
  summary: {
    priorPass: number;
    currentPass: number;
    /** `currentPass - priorPass`. */
    delta: number;
    /** Fixtures that went pass-to-fail. */
    regressions: number;
    /** Percentage-point change in hit rate. */
    deltaPp: number;
  };
  /** True when any pass-to-fail OR `deltaPp <= -10` per spec §9.4. */
  hasRegression: boolean;
}
