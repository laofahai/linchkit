/**
 * Validation Phase 5 — Execution dry-run signal (Spec 70 P2).
 *
 * Phase 5 reads the DURABLE `dryRunStatus` that a Spec 70 sandbox runner stamps
 * on a materializable change (during materialization in P3) and turns a failing
 * outcome into a validation finding. It is the execution counterpart to the
 * static Phase 4 contract check: where Phase 4 verifies the generated source
 * *looks* right, the dry-run observed whether it actually *ran*.
 *
 * SAFETY — EXECUTION-FREE BY DESIGN ("AI never modifies production directly"):
 * this Phase NEVER `eval`s, `import`s, transpiles-and-runs, or invokes an
 * `ExecutionDryRunProvider`. The untrusted AI code is run LATER, once, inside a
 * locked-down capability sandbox (P3) — never as a side effect of validation.
 * Phase 5 only READS the persisted `dryRunStatus`, exactly as Phase 4 reads
 * `materializationStatus: "failed"`. `validateProposal` therefore stays SYNC.
 *
 * Status → finding mapping:
 *   - threw / timeout / oom / forbidden_side_effect / malformed_output → a CONTENT
 *     finding (code `EXECUTION_DRY_RUN_FAILED`). Warn-or-block per the flag below.
 *   - infra_error → ALWAYS a WARNING (distinct code `EXECUTION_DRY_RUN_INFRA`),
 *     regardless of the flag: a flaky/down sandbox is not a content verdict and
 *     must never wedge graduation (Spec 70 §7).
 *   - passed / skipped → no finding.
 *
 * Severity / gating mirrors Phase 2 / Phase 3 / Phase 4 (low-regret):
 *   - DEFAULT: WARN-ONLY. Content findings are `warnings`; `passed` is unaffected.
 *     Synthetic inputs are imperfect, so the dry-run must not block by default.
 *   - GATED: when `strictExecutionDryRun` is true, CONTENT findings become
 *     `errors` (status "failed" → proposal `passed` = false → blocks). Unlike
 *     `strictGeneratedContract`, this flag is OPT-IN everywhere and is NEVER
 *     derived from `isProduction` (Spec 70 §7): the dry-run depends on external
 *     sandbox infra, so auto-blocking on an un-configured/flaky sandbox would
 *     wedge graduation. `infra_error` stays a warning even when this is true.
 *
 * A proposal where no change carries a `dryRunStatus` degrades to "skipped".
 */

import type {
  PhaseResult,
  ProposalChange,
  ValidationError,
  ValidationWarning,
} from "../types/proposal";
import { isMaterializable } from "./proposal-materializer";

// ── Options ──────────────────────────────────────────────

export interface ValidatePhase5Options {
  /** The proposal's changes to inspect for a durable `dryRunStatus`. */
  changes: ProposalChange[];
  /**
   * When true, CONTENT dry-run findings become ERRORS (blocking). Default
   * (false / undefined) → content findings are WARNINGS only and do not affect
   * `passed`. Synthetic inputs are imperfect, so warn-only is the safe default.
   * NOT derived from `isProduction` (Spec 70 §7). `infra_error` is always a
   * warning regardless.
   */
  strictExecutionDryRun?: boolean;
}

// ── Status classification ────────────────────────────────

/**
 * Dry-run statuses that are a CONTENT verdict — the generated handler misbehaved
 * (threw, ran away on resources, attempted a forbidden op, or returned a bad
 * shape). These warn-or-block per `strictExecutionDryRun`.
 */
const CONTENT_FAILURE_STATUSES = new Set<ProposalChange["dryRunStatus"]>([
  "threw",
  "timeout",
  "oom",
  "forbidden_side_effect",
  "malformed_output",
]);

/** Cap a detail string so a single finding message stays reasonable. */
function cap(detail: string): string {
  return detail.length > 300 ? `${detail.slice(0, 297)}...` : detail;
}

/**
 * Extract the first useful human-readable detail from a change's per-case
 * outcomes: an outcome's `error`, else the first recorded `attemptedSideEffects`
 * detail. The outcomes can be rehydrated from persisted JSON, so guard against a
 * malformed array / non-string entries producing a malformed finding message.
 */
function firstOutcomeDetail(change: ProposalChange): string {
  const outcomes = Array.isArray(change.dryRunOutcomes) ? change.dryRunOutcomes : [];
  for (const outcome of outcomes) {
    if (!outcome || typeof outcome !== "object") continue;
    if (typeof outcome.error === "string" && outcome.error.trim().length > 0) {
      return outcome.error.trim();
    }
    const effects = Array.isArray(outcome.attemptedSideEffects) ? outcome.attemptedSideEffects : [];
    for (const effect of effects) {
      if (
        effect &&
        typeof effect === "object" &&
        typeof effect.detail === "string" &&
        effect.detail.trim().length > 0
      ) {
        return effect.detail.trim();
      }
    }
  }
  return "";
}

// ── Entry point ──────────────────────────────────────────

/**
 * Run Phase 5 (execution dry-run signal) validation on a proposal's changes.
 *
 * Returns a PhaseResult:
 *  - no change carries a `dryRunStatus` → status "skipped"
 *  - content findings + strictExecutionDryRun=false → status "passed" with
 *    `warnings` (infra findings are also warnings)
 *  - content findings + strictExecutionDryRun=true  → status "failed" with
 *    `errors` (infra findings stay `warnings`)
 */
export function validatePhase5(options: ValidatePhase5Options): PhaseResult {
  const { changes, strictExecutionDryRun = false } = options;
  const start = Date.now();

  // Only MATERIALIZABLE changes carrying a durable `dryRunStatus` are in scope.
  //
  // Guard with `isMaterializable` (the SAME predicate the materializer and Phase
  // 4 use) so a change carrying a STALE dry-run status from when it WAS
  // materializable but has since been edited to a non-materializable
  // target/operation (e.g. action→entity, create→delete) is NOT flagged — it no
  // longer needs code at all, so reporting it (and blocking under strict) would
  // be wrong.
  const withStatus = changes.filter((c) => c.dryRunStatus !== undefined && isMaterializable(c));

  // Skip when no in-scope change carries a dry-run result — same low-regret
  // degrade as Phase 4 (an all-declarative / never-dry-run proposal).
  if (withStatus.length === 0) {
    return { phase: 5, status: "skipped", errors: [], warnings: [], duration: Date.now() - start };
  }

  // Content findings warn-or-block per the flag; infra findings are ALWAYS
  // warnings (a flaky sandbox must never wedge graduation — Spec 70 §7).
  const contentFindings: Array<{ code: string; message: string; target?: string }> = [];
  const infraWarnings: ValidationWarning[] = [];

  for (const change of withStatus) {
    const status = change.dryRunStatus;
    // passed / skipped → nothing to report.
    if (status === "passed" || status === "skipped") continue;

    if (status === "infra_error") {
      infraWarnings.push({
        code: "EXECUTION_DRY_RUN_INFRA",
        message: `Execution dry-run for ${change.target} "${change.name}" could not run (sandbox infra error); no behavioral verdict was produced.`,
        target: change.name,
      });
      continue;
    }

    if (CONTENT_FAILURE_STATUSES.has(status)) {
      const detail = firstOutcomeDetail(change);
      const suffix = detail ? ` Detail: ${cap(detail)}` : "";
      contentFindings.push({
        code: "EXECUTION_DRY_RUN_FAILED",
        message: `Execution dry-run for ${change.target} "${change.name}" failed (status "${status}") — the generated handler did not run cleanly against the synthetic inputs.${suffix}`,
        target: change.name,
      });
    }
  }

  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [...infraWarnings];
  if (strictExecutionDryRun) {
    for (const f of contentFindings) errors.push(f);
  } else {
    for (const f of contentFindings) warnings.push(f);
  }

  // Warn-only by default: status stays "passed" even with warnings — `passed` is
  // only dragged false when strictExecutionDryRun escalated CONTENT findings to
  // errors. infra_error warnings never affect `passed`.
  const status: PhaseResult["status"] = errors.length === 0 ? "passed" : "failed";

  return { phase: 5, status, errors, warnings, duration: Date.now() - start };
}
