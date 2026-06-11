/**
 * Execution dry-run orchestrator — Spec 70 P3 (the "materialize-path runner").
 *
 * Fans an INJECTED {@link ExecutionDryRunProvider} out over each MATERIALIZED
 * change's (change × synthetic input) pairs, aggregates the per-case outcomes
 * into the WORST-CASE change-level {@link DryRunStatus}, and STAMPS the durable
 * `dryRunStatus`/`dryRunOutcomes` that validation Phase 5 (`validatePhase5`)
 * later READS — exactly as the materializer stamps `materializationStatus` for
 * Phase 4 to read.
 *
 * SAFETY — CORE STAYS EXECUTION-FREE ("AI never modifies production directly"):
 *   - This orchestrator contains NO execution logic. The sandboxed run lives
 *     entirely inside the injected capability (e.g. `@linchkit/cap-dry-run`);
 *     core only SEQUENCES the provider calls and AGGREGATES their results.
 *   - It runs ONLY on already-materialized CANDIDATE source attached to a DRAFT.
 *     It never submits, validates-to-approve, approves, writes, commits, or
 *     graduates anything. The stamped status is an advisory signal a human
 *     reviewer sees; it never auto-advances the proposal.
 *   - OFF BY DEFAULT: a caller opts in by SUPPLYING a provider. With none, no
 *     dry-run runs and `dryRunStatus` stays undefined (Phase 5 → "skipped").
 *   - WARN-ONLY: the dry-run never blocks here; whether a failing status blocks
 *     graduation is Phase 5's decision under the opt-in `strictExecutionDryRun`.
 *
 * A provider that THROWS for one case (the seam contract says it should instead
 * return `infra_error`, but we do not trust it to) is contained: that case
 * degrades to a synthesized `infra_error` outcome so one bad change can never
 * abort the proposal-wide run.
 */

import type { DryRunOutcome, DryRunStatus, ExecutionDryRunProvider } from "../types/dry-run";
import type { ProposalChange, ProposalDefinition } from "../types/proposal";
import { isMaterializable } from "./proposal-materializer";

// ── Options / result ─────────────────────────────────────

/** One synthetic/historical input case fed to a change's handler in the sandbox. */
export interface DryRunInputCase {
  /** Identifies the case for reproducibility (surfaced on each outcome). */
  inputCaseId: string;
  /** The synthetic input passed as `ctx.input`. */
  input: unknown;
  /** Optional ExecutionMeta-like fields the handler may read (Spec 65). */
  metadata?: Record<string, unknown>;
}

export interface DryRunMaterializedOptions {
  /** The DRAFT proposal whose materialized changes to dry-run. Mutated in place. */
  proposal: ProposalDefinition;
  /** The injected sandbox runner (e.g. cap-dry-run's createSubprocessDryRunner). */
  provider: ExecutionDryRunProvider;
  /**
   * Per-change synthetic input cases. Defaults to a SINGLE empty `{}` case — v1
   * is synthetic-only (Spec 70 P3); richer/historical inputs are a later phase.
   * More than {@link MAX_INPUT_CASES} cases are truncated (and reported).
   */
  inputCasesFor?: (change: ProposalChange) => DryRunInputCase[];
  /** Hard resource bounds per case, forwarded to the provider. */
  limits?: { timeoutMs: number; memoryBytes: number };
  /** Tenant id stamped into the shimmed sandbox context. */
  tenantId?: string;
  /**
   * Optional scope: when provided (non-empty), ONLY changes whose `name` is in
   * this list are dry-run; every other change is left UNTOUCHED (its existing
   * `dryRunStatus`/`dryRunOutcomes` preserved). Mirrors `materializeProposalChanges`
   * — in a SCOPED retry that re-materializes one change, the dry-run must not
   * re-run (and possibly regress, e.g. on a transient `infra_error`) the durable
   * signal of out-of-scope changes the materializer deliberately preserved. When
   * absent/empty, every materialized change is dry-run.
   */
  changeNames?: readonly string[];
}

export interface DryRunMaterializedResult {
  /** Change names that were dry-run (had materialized candidate source). */
  ranChangeNames: string[];
  /** Change names skipped (not materializable / not materialized / no source). */
  skippedChangeNames: string[];
  /** Change names whose input-case list was truncated to {@link MAX_INPUT_CASES}. */
  truncatedChangeNames: string[];
}

/** Default per-case resource bounds (mirrors the cap-dry-run runner defaults). */
const DEFAULT_LIMITS = { timeoutMs: 5_000, memoryBytes: 256 * 1024 * 1024 };

/** Bound the fan-out per change so a pathological input provider cannot run away. */
export const MAX_INPUT_CASES = 8;

// ── Worst-case aggregation ───────────────────────────────

/**
 * Severity ranking for picking a change's worst-case status across its input
 * cases. A CONTENT failure (the handler misbehaved) dominates everything;
 * `infra_error` (a sandbox problem, NOT a content verdict) sits below them so a
 * single real `passed`/failure signal is preferred over a flaky-sandbox case;
 * `passed` is the floor above "nothing ran"; `skipped` means no case ran.
 */
const STATUS_SEVERITY: Record<DryRunStatus, number> = {
  forbidden_side_effect: 60,
  malformed_output: 50,
  threw: 40,
  timeout: 30,
  oom: 20,
  infra_error: 10,
  passed: 1,
  skipped: 0,
};

/**
 * Reduce a change's per-case outcomes to the single durable change-level status:
 * the worst (highest-severity) case wins. An empty array → "skipped".
 */
export function aggregateDryRunStatus(outcomes: readonly DryRunOutcome[]): DryRunStatus {
  let worst: DryRunStatus = "skipped";
  for (const outcome of outcomes) {
    const status = outcome?.status;
    if (typeof status !== "string" || !(status in STATUS_SEVERITY)) continue;
    if (STATUS_SEVERITY[status] > STATUS_SEVERITY[worst]) worst = status;
  }
  return worst;
}

// ── Orchestrator ─────────────────────────────────────────

/** The default input-case list when the caller supplies no `inputCasesFor`. */
function defaultInputCases(): DryRunInputCase[] {
  return [{ inputCaseId: "synthetic-0", input: {} }];
}

/** A change is dry-runnable only when its candidate source actually materialized. */
function isDryRunnable(change: ProposalChange): boolean {
  return (
    isMaterializable(change) &&
    change.materializationStatus === "materialized" &&
    typeof change.generatedSource === "string" &&
    change.generatedSource.length > 0
  );
}

/**
 * Dry-run every materialized change of a proposal and stamp the durable
 * `dryRunStatus`/`dryRunOutcomes`. Mutates the passed `proposal.changes` in place
 * (the same object the caller persists), mirroring `materializeProposalChanges`.
 */
export async function dryRunMaterializedChanges(
  options: DryRunMaterializedOptions,
): Promise<DryRunMaterializedResult> {
  const { proposal, provider, inputCasesFor, limits, tenantId, changeNames } = options;
  const effectiveLimits = limits ?? DEFAULT_LIMITS;
  // A non-empty scope restricts the dry-run to the changes (re)materialized in this
  // request; out-of-scope changes keep their prior durable signal untouched.
  const scope = changeNames && changeNames.length > 0 ? new Set(changeNames) : null;
  const ranChangeNames: string[] = [];
  const skippedChangeNames: string[] = [];
  const truncatedChangeNames: string[] = [];

  for (const change of proposal.changes) {
    if ((scope && !scope.has(change.name)) || !isDryRunnable(change)) {
      skippedChangeNames.push(change.name);
      continue;
    }

    const requested = inputCasesFor?.(change) ?? defaultInputCases();
    const cases = requested.slice(0, MAX_INPUT_CASES);
    if (requested.length > MAX_INPUT_CASES) truncatedChangeNames.push(change.name);

    const source = change.generatedSource as string;
    // Run this change's input cases CONCURRENTLY — each is an I/O-bound sandboxed
    // subprocess on the materialize request's critical path, so awaiting them in
    // series needlessly serialises the latency. Concurrency is bounded by
    // `MAX_INPUT_CASES` (the `cases` slice above) and the outer change loop stays
    // sequential, so at most `MAX_INPUT_CASES` sandboxes run at once. `Promise.all`
    // preserves input order, so `dryRunOutcomes` keeps the case order.
    const outcomes: DryRunOutcome[] = await Promise.all(
      cases.map((inputCase) =>
        runOneCase({ provider, change, source, inputCase, limits: effectiveLimits, tenantId }),
      ),
    );

    change.dryRunOutcomes = outcomes;
    change.dryRunStatus = aggregateDryRunStatus(outcomes);
    ranChangeNames.push(change.name);
  }

  return { ranChangeNames, skippedChangeNames, truncatedChangeNames };
}

/**
 * Run one (change × input case) through the provider, containing a throwing
 * provider as a synthesized `infra_error` outcome (the seam SHOULD return one
 * itself, but a misbehaving capability must not abort the proposal-wide run).
 */
async function runOneCase(args: {
  provider: ExecutionDryRunProvider;
  change: ProposalChange;
  source: string;
  inputCase: DryRunInputCase;
  limits: { timeoutMs: number; memoryBytes: number };
  tenantId?: string;
}): Promise<DryRunOutcome> {
  const { provider, change, source, inputCase, limits, tenantId } = args;
  try {
    return await provider.dryRun({
      source,
      target: change.target,
      changeName: change.name,
      input: inputCase.input,
      inputCaseId: inputCase.inputCaseId,
      tenantId,
      metadata: inputCase.metadata,
      limits,
    });
  } catch (error) {
    return {
      changeName: change.name,
      target: change.target,
      status: "infra_error",
      inputCaseId: inputCase.inputCaseId,
      error: `dry-run provider threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
