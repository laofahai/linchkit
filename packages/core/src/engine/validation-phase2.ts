/**
 * Validation Phase 2 — Build (syntax) check of AI-materialized source (G5).
 *
 * Phase 2 inspects any `generatedSource` attached to a proposal's changes (by the
 * proposal materializer) and reports SYNTACTIC build failures. Declarative
 * changes carry no generated source, so for an all-declarative proposal Phase 2
 * degrades to "skipped" — existing callers are unaffected.
 *
 * Severity / gating mirrors Phase 3 (low-regret):
 *   - DEFAULT: WARN-ONLY. Findings are `warnings`; `passed` is unaffected.
 *   - GATED: when `strictGeneratedBuild` is true, findings become `errors`
 *     (status "failed" → proposal `passed` = false → blocks).
 *
 * Scope: SYNTAX only (see {@link checkSourceSyntax}). Project-aware type
 * resolution is out of scope here (no project context at proposal time) and is
 * left to the graduation PR's CI / a later build-time pass.
 */

import type {
  PhaseResult,
  ProposalChange,
  ValidationError,
  ValidationWarning,
} from "../types/proposal";
import { checkSourceSyntax } from "./code-quality-gate";

// ── Options ──────────────────────────────────────────────

export interface ValidatePhase2Options {
  /** The proposal's changes to inspect for materialized `generatedSource`. */
  changes: ProposalChange[];
  /**
   * When true, generated-source syntax findings become ERRORS (blocking).
   * Default (false / undefined) → findings are WARNINGS only and do not affect
   * `passed`. Mirrors the `strictCompatibility` gating of Phase 3.
   */
  strictGeneratedBuild?: boolean;
}

// ── Entry point ──────────────────────────────────────────

/**
 * Run Phase 2 (build/syntax) validation on a proposal's changes.
 *
 * Returns a PhaseResult:
 *  - no change carries `generatedSource` → status "skipped" (no findings)
 *  - findings + strictGeneratedBuild=false → status "passed" with `warnings`
 *  - findings + strictGeneratedBuild=true  → status "failed" with `errors`
 */
export function validatePhase2(options: ValidatePhase2Options): PhaseResult {
  const { changes, strictGeneratedBuild = false } = options;
  const start = Date.now();

  // Include EVERY change carrying a string `generatedSource`, even an empty one:
  // an empty / whitespace materialization is itself a finding (checkSourceSyntax
  // flags it) and must not bypass Phase 2 by being filtered out here. Changes
  // with no generatedSource (undefined) are declarative → nothing to build.
  const withSource = changes.filter((c) => typeof c.generatedSource === "string");

  // Nothing materialized → no build surface → skipped (back-compat).
  if (withSource.length === 0) {
    return { phase: 2, status: "skipped", errors: [], warnings: [], duration: Date.now() - start };
  }

  const findings: Array<{ code: string; message: string; target?: string }> = [];
  for (const change of withSource) {
    const messages = checkSourceSyntax(change.generatedSource as string, `${change.name}.ts`);
    for (const message of messages) {
      findings.push({
        code: "GENERATED_SOURCE_SYNTAX",
        message: `Generated source for ${change.target} "${change.name}" has a syntax error: ${message}`,
        target: change.name,
      });
    }
  }

  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];
  if (strictGeneratedBuild) {
    for (const f of findings) errors.push(f);
  } else {
    for (const f of findings) warnings.push(f);
  }

  // Warn-only by default: status stays "passed" even with warnings — `passed` is
  // only dragged false when strictGeneratedBuild escalated findings to errors.
  const status: PhaseResult["status"] = errors.length === 0 ? "passed" : "failed";

  return { phase: 2, status, errors, warnings, duration: Date.now() - start };
}
