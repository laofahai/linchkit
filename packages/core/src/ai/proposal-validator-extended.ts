/**
 * Extended AI Proposal Validator
 *
 * Composes the four validation phases described in Spec 09 §4.2:
 *   Phase 1 — Static check (security / change-type policy)
 *   Phase 2 — Build check (risk classification)
 *   Phase 3 — Compatibility check (this module wires it in)
 *   Phase 4 — Dry-run (this module wires it in)
 *
 * Phases 1 & 2 are delegated to the existing `validateProposal()` (see
 * `proposal-validator.ts`). Phases 3 & 4 are delegated to the new modules.
 *
 * Existing callers that only need the security pipeline can continue to call
 * `validateProposal()` directly. Callers that want the full Spec-09 pipeline
 * call `validateProposalExtended()` instead.
 */

import { compatibilityCheck } from "./proposal-compatibility-checker";
import type {
  CompatibilityChange,
  CompatibilityRegistrySnapshot,
  CompatibilityResult,
} from "./proposal-compatibility-types";
import { type DryRunResult, dryRunProposal } from "./proposal-dry-run";
import {
  type ProposalChange,
  type ProposalValidationResult,
  type ProposalValidatorConfig,
  validateProposal,
} from "./proposal-validator";

// ── Extended config & result types ───────────────────────────

export interface ExtendedValidatorInput {
  /** Security-level changes for Phase 1+2 */
  securityChanges: ProposalChange[];
  /** Field-level changes for Phase 3+4 (optional — pipeline skips phases without input) */
  compatibilityChanges?: CompatibilityChange[];
  /** Registry snapshot used for Phase 3+4 (required when compatibilityChanges supplied) */
  snapshot?: CompatibilityRegistrySnapshot;
}

export interface ExtendedValidatorConfig {
  /** Forwarded to the security validator */
  security?: ProposalValidatorConfig;
  /** When true, skip Phase 3 even if compatibilityChanges are supplied */
  skipCompatibility?: boolean;
  /** When true, skip Phase 4 even if compatibilityChanges are supplied */
  skipDryRun?: boolean;
}

export type ExtendedPhaseStatus = "passed" | "failed" | "skipped";

export interface ExtendedPhaseSummary {
  phase: 1 | 2 | 3 | 4;
  name: "static" | "build" | "compatibility" | "dry_run";
  status: ExtendedPhaseStatus;
}

export interface ExtendedValidationResult {
  /** True if every executed phase passed */
  passed: boolean;
  /** Phase-by-phase summary */
  phases: ExtendedPhaseSummary[];
  /** Phase 1 + 2 detail (security validator result) */
  security: ProposalValidationResult;
  /** Phase 3 detail (undefined if skipped) */
  compatibility?: CompatibilityResult;
  /** Phase 4 detail (undefined if skipped) */
  dryRun?: DryRunResult;
}

// ── Pipeline ────────────────────────────────────────────────

/**
 * Run the full Spec-09 4-phase validation pipeline on a proposal.
 *
 * Phases 3 and 4 are skipped when either the input does not supply
 * `compatibilityChanges` + `snapshot`, or the config opts out.
 */
export function validateProposalExtended(
  input: ExtendedValidatorInput,
  config?: ExtendedValidatorConfig,
): ExtendedValidationResult {
  // Phase 1+2 — security / static / risk
  const security = validateProposal(input.securityChanges, config?.security);

  const phases: ExtendedPhaseSummary[] = [
    { phase: 1, name: "static", status: security.valid ? "passed" : "failed" },
    {
      phase: 2,
      // Spec 09 Phase 2 here is mapped to the risk classification, which is
      // produced as part of the same call. It is "passed" iff Phase 1 passed.
      name: "build",
      status: security.valid ? "passed" : "failed",
    },
  ];

  let compatibility: CompatibilityResult | undefined;
  let dryRun: DryRunResult | undefined;

  // Narrow once so subsequent uses don't need non-null assertions
  const compatChanges = input.compatibilityChanges;
  const snapshot = input.snapshot;
  const hasPhase34Input =
    compatChanges !== undefined && compatChanges.length > 0 && snapshot !== undefined;

  // Phase 3 — compatibility
  if (hasPhase34Input && !config?.skipCompatibility) {
    compatibility = compatibilityCheck(compatChanges, snapshot);
    phases.push({
      phase: 3,
      name: "compatibility",
      status: compatibility.compatible ? "passed" : "failed",
    });
  } else {
    phases.push({ phase: 3, name: "compatibility", status: "skipped" });
  }

  // Phase 4 — dry-run
  if (hasPhase34Input && !config?.skipDryRun) {
    dryRun = dryRunProposal(compatChanges, snapshot);
    phases.push({
      phase: 4,
      name: "dry_run",
      status: dryRun.ok ? "passed" : "failed",
    });
  } else {
    phases.push({ phase: 4, name: "dry_run", status: "skipped" });
  }

  const passed = phases.every((p) => p.status !== "failed");

  return {
    passed,
    phases,
    security,
    compatibility,
    dryRun,
  };
}

/**
 * Create a reusable extended validator with preset config.
 */
export function createExtendedProposalValidator(config: ExtendedValidatorConfig) {
  return {
    validate: (input: ExtendedValidatorInput) => validateProposalExtended(input, config),
    config,
  };
}
