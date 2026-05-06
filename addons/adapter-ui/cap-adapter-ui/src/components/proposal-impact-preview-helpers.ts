/**
 * Helpers for ProposalImpactPreview (Spec 55 §7.3).
 *
 * Kept separate from the JSX component so the data-shaping logic can be
 * unit-tested without a DOM. The component file imports from here.
 */

import type {
  ConflictFinding,
  PreAnalysisStage,
  PreAnalysisStageResult,
  ProposalPreAnalysisResult,
} from "@linchkit/core";

// ── Tone / severity ─────────────────────────────────────────

/**
 * Visual tone for a stage outcome or a finding.
 *
 * Spec 55 §7.3 talks about Error/Warning/Info severities but the current
 * envelope types don't carry an explicit `severity` field — so we derive a
 * tone from what's available (status, conflict kind, etc).
 */
export type Tone = "error" | "warning" | "success" | "info" | "muted";

/** Tone for the whole stage envelope based on its status. */
export function toneForStatus(status: PreAnalysisStageResult["status"] | undefined): Tone {
  switch (status) {
    case "ok":
      return "success";
    case "error":
      return "error";
    case "skipped":
      return "muted";
    default:
      return "muted";
  }
}

/**
 * Tone for a single conflict finding. Rule conflicts are treated as errors;
 * everything else is a warning. This matches Spec 55 §7.3's intent that an
 * active rule clash blocks the proposal while softer conflicts only warn.
 */
export function toneForConflict(finding: ConflictFinding): Tone {
  return finding.kind === "rule" ? "error" : "warning";
}

// ── Stage ordering ─────────────────────────────────────────

/** Canonical render order for the four stages from Spec 55 §7.3. */
export const STAGE_ORDER: readonly PreAnalysisStage[] = [
  "dedup",
  "conflict",
  "impact",
  "backtest",
] as const;

// ── Conflict grouping ──────────────────────────────────────

/** Conflict findings grouped by kind, preserving original order within each group. */
export interface GroupedConflicts {
  rule: ConflictFinding[];
  state_transition: ConflictFinding[];
  proposal: ConflictFinding[];
  other: ConflictFinding[];
}

/** Group conflict findings by `kind` for sectioned rendering. */
export function groupConflicts(findings: readonly ConflictFinding[]): GroupedConflicts {
  const grouped: GroupedConflicts = {
    rule: [],
    state_transition: [],
    proposal: [],
    other: [],
  };
  for (const f of findings) {
    grouped[f.kind].push(f);
  }
  return grouped;
}

// ── Stage status summary ───────────────────────────────────

/** Compact summary of a pipeline result for header / banner rendering. */
export interface PreAnalysisSummary {
  /** True if the result was produced (non-null) and at least one stage ran. */
  hasData: boolean;
  /** Number of stages that ran (any status). */
  ranCount: number;
  /** Number of stages with status === "error". */
  errorCount: number;
  /** Number of stages with status === "skipped". */
  skippedCount: number;
  /** Total findings across all stages that report them (dedup similar + conflict). */
  totalFindings: number;
}

/** Build a defensive summary from a possibly-null pipeline result. */
export function summarizePreAnalysis(
  result: ProposalPreAnalysisResult | null | undefined,
): PreAnalysisSummary {
  if (!result) {
    return {
      hasData: false,
      ranCount: 0,
      errorCount: 0,
      skippedCount: 0,
      totalFindings: 0,
    };
  }

  let ranCount = 0;
  let errorCount = 0;
  let skippedCount = 0;
  let totalFindings = 0;

  for (const stageKey of STAGE_ORDER) {
    const stage = result.stages[stageKey];
    if (!stage) continue;
    ranCount += 1;
    if (stage.status === "error") errorCount += 1;
    if (stage.status === "skipped") skippedCount += 1;
    if (stage.status === "ok" && stage.data) {
      if (stageKey === "dedup") {
        const dedup = stage.data as { similar?: unknown[] };
        totalFindings += dedup.similar?.length ?? 0;
      } else if (stageKey === "conflict") {
        const conflict = stage.data as { conflicts?: unknown[] };
        totalFindings += conflict.conflicts?.length ?? 0;
      }
    }
  }

  return {
    hasData: ranCount > 0,
    ranCount,
    errorCount,
    skippedCount,
    totalFindings,
  };
}
