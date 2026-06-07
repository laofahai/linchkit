/**
 * Validation Phase 4 — Generated-source CONTRACT check (G5).
 *
 * Phase 4 inspects any `generatedSource` attached to a proposal's changes (by the
 * proposal materializer) and checks — WITHOUT EXECUTING ANYTHING — that the AI
 * actually generated the kind of definition the change declares: the right
 * `define<Target>()` call, a reference to the declared name, and an import from
 * `@linchkit/core`. It catches a class of AI errors that pass the Phase 2 syntax
 * gate yet are wrong (e.g. an empty scaffold, the wrong target, or a mismatched
 * name) before a human reviews the candidate.
 *
 * SAFETY — EXECUTION-FREE BY DESIGN ("AI never modifies production directly"):
 * this NEVER `eval`s, `import`s, transpiles-and-runs, or otherwise executes the
 * generated source. It only does static string/structural heuristics. A true
 * execution-based dry-run (running a generated handler against sample/historical
 * data) requires a locked-down sandbox and is intentionally OUT OF SCOPE here —
 * deferred to a separate, sandbox-gated step so untrusted AI code is never run
 * as a side effect of validation.
 *
 * Severity / gating mirrors Phase 2 / Phase 3 (low-regret):
 *   - DEFAULT: WARN-ONLY. Findings are `warnings`; `passed` is unaffected. The
 *     checks are heuristic, so they must not block by default.
 *   - GATED: when `strictGeneratedContract` is true, findings become `errors`
 *     (status "failed" → proposal `passed` = false → blocks).
 *
 * An all-declarative proposal (no `generatedSource`) degrades to "skipped".
 */

import type {
  PhaseResult,
  ProposalChange,
  ProposalChangeTarget,
  ValidationError,
  ValidationWarning,
} from "../types/proposal";

// ── Options ──────────────────────────────────────────────

export interface ValidatePhase4Options {
  /** The proposal's changes to inspect for materialized `generatedSource`. */
  changes: ProposalChange[];
  /**
   * When true, generated-source contract findings become ERRORS (blocking).
   * Default (false / undefined) → findings are WARNINGS only and do not affect
   * `passed`. The checks are heuristic, so warn-only is the safe default.
   */
  strictGeneratedContract?: boolean;
}

/**
 * Map a materializable target to the `define*()` call its generated source is
 * expected to contain. Only `action` is materializable today (see the proposal
 * materializer's MATERIALIZABLE_TARGETS); other targets are serialized
 * declaratively and never carry `generatedSource`. A target absent from this map
 * simply skips the define-call check (the name/import checks still run).
 */
const DEFINE_CALL_BY_TARGET: Partial<Record<ProposalChangeTarget, string>> = {
  action: "defineAction",
};

const CORE_IMPORT = "@linchkit/core";

// ── Entry point ──────────────────────────────────────────

/**
 * Run Phase 4 (generated-source contract) validation on a proposal's changes.
 *
 * Returns a PhaseResult:
 *  - no change carries a non-empty `generatedSource` → status "skipped"
 *  - findings + strictGeneratedContract=false → status "passed" with `warnings`
 *  - findings + strictGeneratedContract=true  → status "failed" with `errors`
 */
export function validatePhase4(options: ValidatePhase4Options): PhaseResult {
  const { changes, strictGeneratedContract = false } = options;
  const start = Date.now();

  // Only NON-EMPTY generated sources have a contract to check. An empty /
  // whitespace materialization is a Phase 2 (syntax) finding — not re-flagged
  // here. Declarative changes (no generatedSource) have nothing to check.
  const withSource = changes.filter(
    (c) => typeof c.generatedSource === "string" && c.generatedSource.trim().length > 0,
  );

  if (withSource.length === 0) {
    return { phase: 4, status: "skipped", errors: [], warnings: [], duration: Date.now() - start };
  }

  const findings: Array<{ code: string; message: string; target?: string }> = [];
  for (const change of withSource) {
    const source = change.generatedSource as string;

    const expectedCall = DEFINE_CALL_BY_TARGET[change.target];
    if (expectedCall && !source.includes(`${expectedCall}(`)) {
      findings.push({
        code: "GENERATED_SOURCE_CONTRACT",
        message: `Generated source for ${change.target} "${change.name}" does not call ${expectedCall}(...).`,
        target: change.name,
      });
    }

    // The generated definition should reference its declared name. A missing name
    // usually means the AI generated something unrelated or a bare stub.
    if (!source.includes(change.name)) {
      findings.push({
        code: "GENERATED_SOURCE_CONTRACT",
        message: `Generated source for ${change.target} "${change.name}" does not reference its declared name "${change.name}".`,
        target: change.name,
      });
    }

    // Definitions need the define* helpers, which come from @linchkit/core.
    if (!source.includes(CORE_IMPORT)) {
      findings.push({
        code: "GENERATED_SOURCE_CONTRACT",
        message: `Generated source for ${change.target} "${change.name}" does not import from "${CORE_IMPORT}".`,
        target: change.name,
      });
    }
  }

  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];
  if (strictGeneratedContract) {
    for (const f of findings) errors.push(f);
  } else {
    for (const f of findings) warnings.push(f);
  }

  // Warn-only by default: status stays "passed" even with warnings — `passed` is
  // only dragged false when strictGeneratedContract escalated findings to errors.
  const status: PhaseResult["status"] = errors.length === 0 ? "passed" : "failed";

  return { phase: 4, status, errors, warnings, duration: Date.now() - start };
}
