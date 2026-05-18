/**
 * Proposal Migration Validator (Spec 62 §5)
 *
 * Inspects a {@link MigrationPlan} and surfaces safety issues before the plan
 * reaches a human approver. Pure, runtime-agnostic:
 *
 *  - Destructive operations are flagged (DROP, lossy ALTER, drop FK)
 *  - Each change is tagged with a reversibility verdict
 *  - `dataLossSimulationRequired` is a boolean placeholder for the dry-run
 *    described in Spec 62 §5.3 — the runtime-agnostic validator cannot run a
 *    real query, but it signals when one is needed.
 *
 * The validator never throws. All findings are returned in a
 * {@link MigrationValidationResult}.
 */
import { isTypeWidening } from "./proposal-migration-detector";
import type {
  MigrationChange,
  MigrationIssueSeverity,
  MigrationPlan,
  MigrationValidationIssue,
  MigrationValidationResult,
  ReversibilityTag,
} from "./proposal-migration-types";

// ── Reversibility ────────────────────────────────────────────

const REVERSIBILITY_ORDER: Record<ReversibilityTag, number> = {
  reversible: 0,
  partial: 1,
  irreversible: 2,
};

function reversibilityOf(change: MigrationChange): ReversibilityTag {
  switch (change.kind) {
    case "create_table":
      return "reversible";
    case "drop_table":
      // Schema can be recreated, but stored rows are gone forever.
      return "irreversible";
    case "add_column":
      // Adding an optional column is fully reversible; adding a required one
      // with a backfilled value loses the backfilled data on rollback.
      return change.definition.required && change.definition.default === undefined
        ? "partial"
        : "reversible";
    case "drop_column":
      return "irreversible";
    case "alter_column_type":
      return isTypeWidening(change.fromType, change.toType) ? "reversible" : "irreversible";
    case "rename_column":
      return "reversible";
    case "add_foreign_key":
    case "drop_foreign_key":
      return "reversible";
  }
}

function worstReversibility(changes: MigrationChange[]): ReversibilityTag {
  let worst: ReversibilityTag = "reversible";
  for (const change of changes) {
    const tag = reversibilityOf(change);
    if (REVERSIBILITY_ORDER[tag] > REVERSIBILITY_ORDER[worst]) {
      worst = tag;
    }
  }
  return worst;
}

// ── Destructiveness ──────────────────────────────────────────

function isDestructive(change: MigrationChange): boolean {
  switch (change.kind) {
    case "drop_column":
    case "drop_table":
      return true;
    case "alter_column_type":
      return !isTypeWidening(change.fromType, change.toType);
    case "drop_foreign_key":
      // FK drop does not delete data, but downgrades referential integrity —
      // treat as destructive so the validator surfaces a warning.
      return true;
    case "create_table":
    case "add_column":
    case "add_foreign_key":
    case "rename_column":
      return false;
  }
}

// ── Per-change rules ─────────────────────────────────────────

interface IssueDraft {
  rule: string;
  severity: MigrationIssueSeverity;
  reason: string;
}

function rulesForChange(change: MigrationChange): IssueDraft[] {
  const drafts: IssueDraft[] = [];

  switch (change.kind) {
    case "drop_column":
      drafts.push({
        rule: "destructive_drop_column",
        severity: "error",
        reason:
          `Dropping column "${change.entity}.${change.field}" is destructive — ` +
          `existing data will be lost`,
      });
      break;
    case "drop_table":
      drafts.push({
        rule: "destructive_drop_table",
        severity: "error",
        reason: `Dropping table "${change.entity}" is destructive — all rows will be lost`,
      });
      break;
    case "alter_column_type":
      if (!isTypeWidening(change.fromType, change.toType)) {
        drafts.push({
          rule: "lossy_type_change",
          severity: "error",
          reason:
            `Changing "${change.entity}.${change.field}" from "${change.fromType}" ` +
            `to "${change.toType}" is lossy and irreversible`,
        });
      }
      break;
    case "add_column":
      if (change.definition.required && change.definition.default === undefined) {
        drafts.push({
          rule: "add_required_column_without_default",
          severity: "warning",
          reason:
            `Adding required column "${change.entity}.${change.field}" without a default ` +
            `requires a backfill before NOT NULL can be enforced`,
        });
      }
      break;
    case "drop_foreign_key":
      drafts.push({
        rule: "drop_foreign_key_relaxes_integrity",
        severity: "warning",
        reason:
          `Dropping foreign key on "${change.entity}.${change.foreignKey.field}" ` +
          `removes referential integrity enforcement`,
      });
      break;
    case "rename_column":
      drafts.push({
        rule: "rename_requires_dual_read",
        severity: "info",
        reason:
          `Renaming "${change.entity}.${change.fromField}" → "${change.toField}" — ` +
          `old code must dual-read during the migrate phase`,
      });
      break;
    case "add_foreign_key":
    case "create_table":
      // No safety concerns for purely additive structures.
      break;
  }

  return drafts;
}

// ── Public API ───────────────────────────────────────────────

/**
 * Validate a migration plan. Returns a structured result — never throws.
 *
 * `valid` is true only when no `error` issues are present. `destructive` and
 * `reversibility` summarise the worst-case across the plan so callers can
 * gate auto-execution on these fields without inspecting every issue.
 */
export function validateMigrationPlan(plan: MigrationPlan): MigrationValidationResult {
  const issues: MigrationValidationIssue[] = [];
  let destructive = false;

  for (const change of plan.changes) {
    const reversibility = reversibilityOf(change);
    if (isDestructive(change)) {
      destructive = true;
    }
    for (const draft of rulesForChange(change)) {
      issues.push({
        rule: draft.rule,
        severity: draft.severity,
        change,
        reason: draft.reason,
        reversibility,
      });
    }
  }

  const valid = !issues.some((issue) => issue.severity === "error");

  return {
    valid,
    destructive,
    reversibility: worstReversibility(plan.changes),
    // Spec 62 §5.3: dry-run data-loss simulation should run whenever the
    // plan touches existing data — i.e. anything destructive or any lossy
    // narrowing alter. Pure validator only flags the need, not the result.
    dataLossSimulationRequired: destructive,
    issues,
  };
}
