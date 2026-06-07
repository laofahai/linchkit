/**
 * Helpers for ProposalValidationFindings (Spec 09 §4.5 — compatibility checks).
 *
 * Kept separate from the JSX component so the data-shaping logic can be
 * unit-tested without a DOM (the package has no jsdom/happy-dom; tests are
 * logic-only). The component file imports from here.
 *
 * Validation produces, per phase, `errors` (blocking) and `warnings`
 * (advisory). Phase 3 is the compatibility / breaking-reference phase: its
 * findings (codes like BREAKING_FIELD_DELETE) tell a reviewer the proposal
 * would break existing references. This module selects the phases worth showing
 * and counts findings — purely defensive against missing / partial data.
 */

import type {
  ProposalValidationFinding,
  ProposalValidationPhase,
  ProposalValidationResult,
} from "../lib/proposal-api";

// ── Constants ───────────────────────────────────────────────

/** The compatibility / breaking-reference phase (Spec 09 §4.5). */
export const COMPATIBILITY_PHASE = 3;

/** Visual tone for a finding group. */
export type FindingTone = "error" | "warning";

// ── Phase selection ─────────────────────────────────────────

/**
 * A phase that actually carries findings worth rendering. Skipped phases and
 * clean (zero-finding) phases are excluded so the panel only shows signal.
 */
export interface PhaseWithFindings {
  phase: number;
  status: string;
  errors: ProposalValidationFinding[];
  warnings: ProposalValidationFinding[];
  /** True when this is the compatibility phase (Phase 3) — emphasised in UI. */
  isCompatibility: boolean;
}

/** True when a phase has at least one error or warning to show. */
function phaseHasFindings(phase: ProposalValidationPhase): boolean {
  const errorCount = phase.errors?.length ?? 0;
  const warningCount = phase.warnings?.length ?? 0;
  return errorCount > 0 || warningCount > 0;
}

/**
 * Select the phases that should be rendered: non-skipped phases that carry at
 * least one finding. Defensive against a null/undefined result, a missing
 * `phases` array, and phases missing their `errors` / `warnings` arrays.
 *
 * Phase 3 (compatibility) is sorted FIRST so the most safety-relevant findings
 * lead; remaining phases keep their natural numeric order.
 */
export function selectPhasesWithFindings(
  result: ProposalValidationResult | null | undefined,
): PhaseWithFindings[] {
  const phases = result?.phases;
  if (!Array.isArray(phases)) return [];

  const selected: PhaseWithFindings[] = [];
  for (const phase of phases) {
    if (!phase) continue;
    if (phase.status === "skipped") continue;
    if (!phaseHasFindings(phase)) continue;
    selected.push({
      phase: phase.phase,
      status: phase.status,
      errors: phase.errors ?? [],
      warnings: phase.warnings ?? [],
      isCompatibility: phase.phase === COMPATIBILITY_PHASE,
    });
  }

  // Compatibility phase first, then ascending phase number.
  return selected.sort((a, b) => {
    if (a.isCompatibility !== b.isCompatibility) return a.isCompatibility ? -1 : 1;
    return a.phase - b.phase;
  });
}

// ── Counting ────────────────────────────────────────────────

/** Aggregate finding counts across every non-skipped phase. */
export interface FindingCounts {
  errors: number;
  warnings: number;
}

/**
 * Count total errors and warnings across all phases of a result. Defensive
 * against null/partial data — returns zeros rather than throwing.
 */
export function countFindings(result: ProposalValidationResult | null | undefined): FindingCounts {
  const phases = result?.phases;
  if (!Array.isArray(phases)) return { errors: 0, warnings: 0 };

  let errors = 0;
  let warnings = 0;
  for (const phase of phases) {
    if (!phase || phase.status === "skipped") continue;
    errors += phase.errors?.length ?? 0;
    warnings += phase.warnings?.length ?? 0;
  }
  return { errors, warnings };
}

/**
 * True when there is at least one finding worth surfacing. Used by the
 * component to decide whether to render anything at all.
 */
export function hasAnyFindings(result: ProposalValidationResult | null | undefined): boolean {
  const { errors, warnings } = countFindings(result);
  return errors > 0 || warnings > 0;
}
