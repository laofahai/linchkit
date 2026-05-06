/**
 * Backtest analyzer — Spec 55 §7.3 stage 4.
 *
 * Replays a candidate Proposal against historical data and reports counter-factual
 * deltas — "if this change had been live for the last N days, how many executions
 * / transitions / records would be different?". The result feeds the Proposal review
 * UI so reviewers see concrete consequences rather than abstract diffs.
 *
 * Branches by proposal change target:
 *
 *   - `rule`   — Estimate how many past executions match the new rule's conditions.
 *                Only declarative conditions are statically evaluable. Code
 *                conditions surface a `summary` and contribute 0.
 *   - `state`  — Replay historical state transitions for the entity inside the
 *                window and count those that would now be illegal under the
 *                proposed state machine.
 *   - `entity` — Scan current records for the entity and count those that would
 *                violate the new field's constraints (required / enum / type).
 *
 * The analyzer is deliberately first-order: it never walks relations, never tries
 * to re-execute Actions, and never mutates the data provider. A bounded scan
 * window (default 30 days) keeps the call cheap on large execution logs.
 *
 * Failures are caught and surfaced into `summary` so the pipeline never aborts
 * on a flaky data provider.
 */

import { evaluateCondition } from "../../engine/condition-evaluator";
import type { EntityDefinition, FieldDefinition } from "../../types/entity";
import type { ExecutionLogEntry } from "../../types/execution-log";
import type {
  ProposalChange,
  ProposalChangeTarget,
  ProposalDefinition,
} from "../../types/proposal";
import type {
  CodeCondition,
  DeclarativeCondition,
  RuleDefinition,
  RuleTrigger,
} from "../../types/rule";
import type { StateDefinition } from "../../types/state";
import type { BacktestResult, PreAnalyzer } from "./types";

// ── Constants ──────────────────────────────────────────────

/** Default historical window when callers don't pin one. Spec 55 §7.3. */
const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_MAX_RECORDS_TO_SCAN = 10_000;

/** Targets the analyzer knows how to replay. */
const REPLAYABLE_TARGETS: ReadonlySet<ProposalChangeTarget> = new Set<ProposalChangeTarget>([
  "rule",
  "state",
  "entity",
]);

// ── Data provider contract ─────────────────────────────────

/**
 * Minimal read-only data provider the backtest analyzer depends on.
 *
 * Kept narrow so any backend (in-memory test double, Drizzle adapter, capability
 * repository) can satisfy it. The optional `listStateTransitions` is split out
 * because some stores recover transitions from the execution log itself, in
 * which case the analyzer falls back to scanning `listExecutionsSince`.
 */
export interface BacktestDataProvider {
  /** Return execution log entries with `startedAt >= since`. */
  listExecutionsSince(since: Date): Promise<ExecutionLogEntry[]>;
  /**
   * Optional action-filtered scan. When the underlying store can index by
   * action name (DB column, structured log) callers should implement this so
   * the analyzer doesn't pull every execution into memory and filter in JS.
   * If absent, the analyzer falls back to `listExecutionsSince` + filter.
   */
  listExecutionsByAction?(
    actionNames: readonly string[],
    since: Date,
  ): Promise<ExecutionLogEntry[]>;
  /**
   * Return entity rows for replay (used by entity-field constraint checks).
   * Honor the `limit` argument when provided — for large entities the
   * analyzer asks for only `maxRecordsToScan` rows.
   */
  listRecords(entity: string, limit?: number): Promise<Array<Record<string, unknown>>>;
  /**
   * Return historical state-transition rows for `entity` in the window. When
   * absent, the analyzer derives transitions from execution log entries that
   * carry `entity === <entity>` and a non-null `stateTransition`.
   */
  listStateTransitions?(
    entity: string,
    since: Date,
  ): Promise<Array<{ from: string; to: string; recordId: string }>>;
}

// ── Options ────────────────────────────────────────────────

export interface CreateBacktestAnalyzerOptions {
  /** Where to fetch historical executions / records / transitions. */
  dataProvider: BacktestDataProvider;
  /** Window in days. Default: 30. Negative / NaN values fall back to the default. */
  windowDays?: number;
  /**
   * Cap on records scanned per entity-replay branch. Defaults to 10_000 to
   * keep pre-analysis bounded for large stores. When the cap is hit the
   * analyzer surfaces `entity:scan-truncated:<count>` in the summary so
   * reviewers know the count is a lower bound.
   */
  maxRecordsToScan?: number;
  /** Optional clock for deterministic tests. Default: `() => new Date()`. */
  now?: () => Date;
}

// ── Helpers ────────────────────────────────────────────────

function isReplayableChange(change: ProposalChange): boolean {
  if (!REPLAYABLE_TARGETS.has(change.target)) return false;
  // Replay only makes sense when there's a definition we can evaluate against.
  // A bare `delete` on entity / state / rule with no definition still has a
  // useful interpretation (state: every transition becomes illegal; rule: no
  // future trigger; entity: every row violates "no such entity"). Those are
  // out of first-order scope, so we skip them and rely on summary text.
  return Boolean(change.definition);
}

/** Coerce the `windowDays` option to a positive integer with the default fallback. */
function resolveWindowDays(input: number | undefined): number {
  if (typeof input !== "number" || !Number.isFinite(input) || input <= 0) {
    return DEFAULT_WINDOW_DAYS;
  }
  return Math.floor(input);
}

/** Coerce the `maxRecordsToScan` option to a positive integer with the default. */
function resolveMaxRecordsToScan(input: number | undefined): number {
  if (typeof input !== "number" || !Number.isFinite(input) || input <= 0) {
    return DEFAULT_MAX_RECORDS_TO_SCAN;
  }
  return Math.floor(input);
}

/** Subtract `days` from `now` and return the lower-bound timestamp. */
function windowStart(now: Date, days: number): Date {
  const ms = days * 24 * 60 * 60 * 1000;
  return new Date(now.getTime() - ms);
}

/** Type guard — RuleTrigger that constrains by action name. */
function actionNamesFromTrigger(trigger: RuleTrigger | undefined): string[] | null {
  if (!trigger) return null;
  if ("action" in trigger) {
    const a = trigger.action;
    return Array.isArray(a) ? a : [a];
  }
  return null;
}

/** Treat declarative conditions as evaluable; code conditions are opaque. */
function isDeclarative(
  condition: DeclarativeCondition | CodeCondition | undefined,
): condition is DeclarativeCondition {
  return Boolean(condition) && typeof condition !== "function";
}

/** Build a ConditionContext from an execution log entry. */
function ctxFromExecution(entry: ExecutionLogEntry): {
  target: Record<string, unknown>;
  context: Record<string, unknown>;
  actor: { type: string; id: string; groups: string[] };
} {
  return {
    // Treat the input as the rule's target — matches how live evaluation wires
    // declarative conditions today (see rule-engine.ts).
    target: entry.input ?? {},
    context: {
      action: entry.action,
      entity: entry.entity ?? "",
      recordId: entry.recordId ?? "",
      status: entry.status,
      // Surface state-transition payload so declarative conditions that depend
      // on transition metadata (e.g. context.from / context.to) can evaluate
      // against historical executions.
      from: entry.stateTransition?.from,
      to: entry.stateTransition?.to,
      stateTransition: entry.stateTransition,
    },
    actor: {
      type: entry.actor?.type ?? "system",
      id: entry.actor?.id ?? "",
      groups: Array.isArray((entry.actor as { groups?: string[] } | undefined)?.groups)
        ? ((entry.actor as { groups?: string[] }).groups as string[])
        : [],
    },
  };
}

// ── Per-target replay ──────────────────────────────────────

interface ReplayContext {
  provider: BacktestDataProvider;
  windowDays: number;
  windowSince: Date;
  maxRecordsToScan: number;
}

interface BranchResult {
  count: number;
  /** Optional note to merge into the aggregate summary. */
  note?: string;
}

async function replayRule(change: ProposalChange, ctx: ReplayContext): Promise<BranchResult> {
  const def = change.definition as RuleDefinition | undefined;
  if (!def) return { count: 0, note: "rule:no-definition" };

  if (!isDeclarative(def.condition)) {
    return { count: 0, note: "rule conditions not statically evaluable" };
  }

  const actionNames = actionNamesFromTrigger(def.trigger);
  // Prefer indexed action-filtered scan when the provider supports it. Falling
  // back to listExecutionsSince + JS filter is fine for in-memory test doubles
  // but unsuitable for production-sized stores.
  let executions: ExecutionLogEntry[];
  if (actionNames && typeof ctx.provider.listExecutionsByAction === "function") {
    executions = await ctx.provider.listExecutionsByAction(actionNames, ctx.windowSince);
  } else {
    executions = await ctx.provider.listExecutionsSince(ctx.windowSince);
  }

  let triggered = 0;
  for (const entry of executions) {
    if (actionNames && !actionNames.includes(entry.action)) continue;
    try {
      if (evaluateCondition(def.condition, ctxFromExecution(entry))) triggered++;
    } catch {
      // A mis-typed condition for a single entry should not poison the run.
      // Skip and keep going.
    }
  }

  return { count: triggered };
}

async function replayState(change: ProposalChange, ctx: ReplayContext): Promise<BranchResult> {
  const def = change.definition as StateDefinition | undefined;
  if (!def?.entity) return { count: 0, note: "state:no-entity" };

  const allowed = new Set<string>();
  for (const t of def.transitions ?? []) {
    const froms = Array.isArray(t.from) ? t.from : [t.from];
    for (const from of froms) allowed.add(`${from}→${t.to}`);
  }

  // Prefer the dedicated transition source; fall back to execution log scanning
  // so test doubles and minimal providers still produce useful counts.
  let transitions: Array<{ from: string; to: string }> = [];
  if (typeof ctx.provider.listStateTransitions === "function") {
    transitions = await ctx.provider.listStateTransitions(def.entity, ctx.windowSince);
  } else {
    const executions = await ctx.provider.listExecutionsSince(ctx.windowSince);
    transitions = executions
      .filter((e) => e.entity === def.entity && e.stateTransition && e.status === "succeeded")
      .map((e) => ({
        from: (e.stateTransition as { from: string; to: string }).from,
        to: (e.stateTransition as { from: string; to: string }).to,
      }));
  }

  let illegal = 0;
  for (const t of transitions) {
    if (!allowed.has(`${t.from}→${t.to}`)) illegal++;
  }
  return { count: illegal };
}

/** Validate a single record value against a field definition's constraints. */
function violatesField(value: unknown, field: FieldDefinition): boolean {
  const isNullish = value === null || value === undefined;

  // Required check first — a required field with no value always violates,
  // regardless of type.
  if (field.required && isNullish) return true;
  // Optional + missing is fine; bail out before the type check so we don't
  // false-positive on legitimately empty optional fields.
  if (isNullish) return false;

  switch (field.type) {
    case "string":
    case "text":
      if (typeof value !== "string") return true;
      if (typeof field.min === "number" && value.length < field.min) return true;
      if (typeof field.max === "number" && value.length > field.max) return true;
      return false;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return true;
      if (typeof field.min === "number" && value < field.min) return true;
      if (typeof field.max === "number" && value > field.max) return true;
      return false;
    case "boolean":
      return typeof value !== "boolean";
    case "date":
    case "datetime":
      // Accept ISO strings, Date instances, and numeric epochs — Drizzle and
      // InMemoryStore each emit a different shape.
      if (value instanceof Date) return Number.isNaN(value.getTime());
      if (typeof value === "string") return Number.isNaN(Date.parse(value));
      if (typeof value === "number") return !Number.isFinite(value);
      return true;
    case "enum": {
      const opts = field.options;
      if (!Array.isArray(opts)) return false;
      return !opts.some((o) => o.value === value);
    }
    case "json":
      // JSON fields accept any non-null value. Nullish is already handled above.
      return false;
    case "state":
      // State values must be strings. The state machine itself validates the
      // value space; that's covered by the `state` branch above.
      return typeof value !== "string";
    case "computed":
      // Computed fields aren't user-input; never count them as a violation.
      return false;
    default:
      return false;
  }
}

async function replayEntity(change: ProposalChange, ctx: ReplayContext): Promise<BranchResult> {
  // Spec 63 immutable / lock semantics intentionally aren't backtested here —
  // they apply to writes, not to the snapshot of stored rows.
  const def = change.definition as EntityDefinition | undefined;
  if (!def?.name || !def.fields) return { count: 0, note: "entity:no-definition" };

  // Creating a brand-new entity has no historical rows to replay against.
  if (change.operation === "create") return { count: 0, note: "entity:create-no-history" };

  // Bounded scan: ask the provider for `maxRecordsToScan + 1` rows so we can
  // detect a truncation event even when the provider honors the limit hint.
  // Providers that ignore the hint still get a JS-side slice safety net so
  // memory pressure stays predictable.
  const probe = ctx.maxRecordsToScan + 1;
  const fetched = await ctx.provider.listRecords(def.name, probe);
  if (fetched.length === 0) return { count: 0 };

  const fieldEntries = Object.entries(def.fields);
  if (fieldEntries.length === 0) return { count: 0 };

  const truncated = fetched.length >= probe;
  const records = truncated ? fetched.slice(0, ctx.maxRecordsToScan) : fetched;

  let violations = 0;
  for (const record of records) {
    let recordViolates = false;
    for (const [fieldName, fieldDef] of fieldEntries) {
      if (violatesField(record[fieldName], fieldDef)) {
        recordViolates = true;
        break;
      }
    }
    if (recordViolates) violations++;
  }

  return {
    count: violations,
    note: truncated ? `entity:scan-truncated:${ctx.maxRecordsToScan}` : undefined,
  };
}

// ── Public factory ─────────────────────────────────────────

export function createBacktestAnalyzer(
  options: CreateBacktestAnalyzerOptions,
): PreAnalyzer<"backtest", BacktestResult> {
  const windowDays = resolveWindowDays(options.windowDays);
  const maxRecordsToScan = resolveMaxRecordsToScan(options.maxRecordsToScan);
  const now = options.now ?? (() => new Date());

  return {
    stage: "backtest",
    name: "default-backtest-analyzer",
    async analyze(proposal: ProposalDefinition): Promise<BacktestResult> {
      const replayable = proposal.changes.filter(isReplayableChange);

      if (replayable.length === 0) {
        return {
          windowDays,
          hypotheticalTriggerCount: 0,
          summary: "no replayable changes",
        };
      }

      const ctx: ReplayContext = {
        provider: options.dataProvider,
        windowDays,
        windowSince: windowStart(now(), windowDays),
        maxRecordsToScan,
      };

      let total = 0;
      const notes: string[] = [];
      for (const change of replayable) {
        try {
          let branchResult: BranchResult;
          if (change.target === "rule") {
            branchResult = await replayRule(change, ctx);
          } else if (change.target === "state") {
            branchResult = await replayState(change, ctx);
          } else if (change.target === "entity") {
            branchResult = await replayEntity(change, ctx);
          } else {
            // Defensive — REPLAYABLE_TARGETS already filtered these out, but
            // keep the explicit branch so future target additions surface
            // here rather than silently contributing 0.
            branchResult = { count: 0, note: `unsupported target: ${change.target}` };
          }
          total += branchResult.count;
          if (branchResult.note) notes.push(branchResult.note);
        } catch (err) {
          // Provider failure for one change must not nuke the rest. Swallow
          // and surface into summary so the reviewer knows replay was partial.
          const message = err instanceof Error ? err.message : String(err);
          notes.push(`error replaying ${change.target} "${change.name}": ${message}`);
        }
      }

      return {
        windowDays,
        hypotheticalTriggerCount: total,
        summary: notes.length > 0 ? notes.join("; ") : undefined,
      };
    },
  };
}
