/**
 * DryRunOutcomesPanel — renders the durable execution dry-run signal on the
 * proposal review page (Spec 70 P4).
 *
 * When the LINCHKIT_EXECUTION_DRY_RUN feature is on and the materialize path
 * has an `ExecutionDryRunProvider` wired in, each materializable change gets a
 * sandbox dry-run whose outcome is stamped durably as `dryRunStatus` /
 * `dryRunOutcomes`. This component surfaces that signal to the human reviewer:
 * - `passed` — sandbox ran clean; reassurance that the generated handler works.
 * - `threw` / `timeout` / `oom` / `malformed_output` — actionable signal; the
 *   reviewer should inspect the source or ask for a re-generation.
 * - `forbidden_side_effect` — the handler tried I/O it must not perform; the
 *   attempted operations are listed so the reviewer can judge whether to approve.
 * - `infra_error` — the sandbox itself failed (infra, not content); advisory only,
 *   never blocks graduation (Spec 70 §7).
 *
 * Only changes with a non-"skipped" `dryRunStatus` appear here. A "skipped"
 * status means no runner was configured or the change was not materializable —
 * nothing for the reviewer to act on.
 *
 * The scoped "Re-run" button calls the parent's `onRerunChange` callback with the
 * change name; the parent then calls `materializeProposal` scoped to that change
 * (which re-generates source AND re-runs the dry-run).
 */

import { Button } from "@linchkit/ui-kit/components";
import {
  ActivityIcon,
  AlertTriangleIcon,
  CheckCircle2Icon,
  InfoIcon,
  Loader2Icon,
  RefreshCwIcon,
  ShieldAlertIcon,
} from "lucide-react";
import type { useTranslation } from "react-i18next";
import type { DryRunOutcome, ProposalChange } from "@/lib/proposal-api";

type TFn = ReturnType<typeof useTranslation>["t"];

/** Tailwind badge classes and icon for each dry-run status. */
function statusStyle(status: string): {
  badge: string;
  icon: React.ReactNode;
} {
  switch (status) {
    case "passed":
      return {
        badge:
          "bg-green-50 border-green-200 dark:bg-green-950/30 dark:border-green-900 text-green-700 dark:text-green-300",
        icon: <CheckCircle2Icon className="size-3.5 text-green-600 dark:text-green-400" />,
      };
    case "infra_error":
      return {
        badge:
          "bg-yellow-50 border-yellow-200 dark:bg-yellow-950/30 dark:border-yellow-900 text-yellow-700 dark:text-yellow-300",
        icon: <InfoIcon className="size-3.5 text-yellow-600 dark:text-yellow-400" />,
      };
    case "forbidden_side_effect":
      return {
        badge:
          "bg-red-50 border-red-200 dark:bg-red-950/30 dark:border-red-900 text-red-700 dark:text-red-300",
        icon: <ShieldAlertIcon className="size-3.5 text-red-600 dark:text-red-400" />,
      };
    default:
      // threw / timeout / oom / malformed_output
      return {
        badge:
          "bg-red-50 border-red-200 dark:bg-red-950/30 dark:border-red-900 text-red-700 dark:text-red-300",
        icon: <AlertTriangleIcon className="size-3.5 text-red-600 dark:text-red-400" />,
      };
  }
}

/** Human-readable label for a dry-run status value. */
function statusLabel(status: string, t: TFn): string {
  switch (status) {
    case "passed":
      return t("proposals.dryRunBadgePassed", "passed");
    case "threw":
      return t("proposals.dryRunBadgeThrew", "threw");
    case "timeout":
      return t("proposals.dryRunBadgeTimeout", "timeout");
    case "oom":
      return t("proposals.dryRunBadgeOom", "out of memory");
    case "forbidden_side_effect":
      return t("proposals.dryRunBadgeForbiddenOp", "forbidden op");
    case "malformed_output":
      return t("proposals.dryRunBadgeMalformedOutput", "bad output");
    case "infra_error":
      return t("proposals.dryRunBadgeInfraError", "infra warning");
    default:
      return status;
  }
}

/** Human-readable label for an `AttemptedSideEffect.kind`. */
function kindLabel(kind: string, t: TFn): string {
  switch (kind) {
    case "db_write":
      return t("proposals.dryRunKindDbWrite", "DB write");
    case "db_read":
      return t("proposals.dryRunKindDbRead", "DB read");
    case "network":
      return t("proposals.dryRunKindNetwork", "network");
    case "fs":
      return t("proposals.dryRunKindFs", "filesystem");
    case "env":
      return t("proposals.dryRunKindEnv", "env access");
    default:
      return t("proposals.dryRunKindUnknown", "side effect");
  }
}

function DryRunChangeRow({
  change,
  t,
  onRerunChange,
  rerunningChange,
  disabled,
}: {
  change: ProposalChange;
  t: TFn;
  onRerunChange?: (changeName: string) => void;
  rerunningChange?: string | null;
  disabled?: boolean;
}) {
  const status = change.dryRunStatus ?? "skipped";
  const { badge, icon } = statusStyle(status);
  const outcomes: DryRunOutcome[] = change.dryRunOutcomes ?? [];
  // Collect all attempted side effects across input cases.
  const sideEffects = outcomes.flatMap((o) => o.attemptedSideEffects ?? []);
  // First error message across cases, if any.
  const firstError = outcomes.find((o) => typeof o.error === "string")?.error;

  return (
    <div className={`rounded-md border ${badge}`}>
      <div className="flex items-center gap-2 px-3 py-2 text-xs font-medium">
        {icon}
        <span
          className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase"
          style={{ background: "rgba(0,0,0,.06)" }}
        >
          {statusLabel(status, t)}
        </span>
        <span className="min-w-0 flex-1 truncate">
          {change.target}/{change.name}
        </span>
        {/* Per-change re-run: scopes a materialize to JUST this change so the
            reviewer can re-generate one change without touching the good ones. */}
        {onRerunChange && (
          <Button
            size="sm"
            variant="outline"
            className="h-6 shrink-0 px-2 text-[11px]"
            onClick={() => onRerunChange(change.name)}
            disabled={disabled || !!rerunningChange}
          >
            {rerunningChange === change.name ? (
              <Loader2Icon className="mr-1 size-3 animate-spin" />
            ) : (
              <RefreshCwIcon className="mr-1 size-3" />
            )}
            {t("proposals.dryRunRerun", "Re-run")}
          </Button>
        )}
      </div>
      {/* Attempted side effects for forbidden_side_effect status. */}
      {sideEffects.length > 0 && (
        <div className="border-t border-inherit px-3 py-2 space-y-1">
          <p className="text-[11px] font-medium opacity-80">
            {t("proposals.dryRunAttemptedOps", "Attempted operations")}
          </p>
          {sideEffects.map((se, i) => (
            // Static, append-only list with no id — index keys are fine.
            // biome-ignore lint/suspicious/noArrayIndexKey: static side-effect list, no id
            <div key={i} className="flex items-baseline gap-1.5 text-[11px]">
              <span className="shrink-0 rounded bg-black/10 dark:bg-white/10 px-1 py-0.5 text-[10px] font-mono font-semibold uppercase">
                {kindLabel(se.kind, t)}
              </span>
              <code className="min-w-0 break-all font-mono opacity-70">{se.detail}</code>
            </div>
          ))}
        </div>
      )}
      {/* Error detail for threw / malformed_output / timeout / oom. */}
      {firstError && sideEffects.length === 0 && (
        <div className="border-t border-inherit px-3 py-2 font-mono text-[11px] leading-relaxed opacity-70">
          <code className="block whitespace-pre-wrap">{firstError}</code>
        </div>
      )}
    </div>
  );
}

export function DryRunOutcomesPanel({
  changes,
  t,
  onRerunChange,
  rerunningChange,
  disabled,
}: {
  /** Changes with a non-"skipped" `dryRunStatus` (pre-filtered by the parent). */
  changes: readonly ProposalChange[];
  t: TFn;
  /**
   * Optional callback raised when the reviewer clicks "Re-run" on a change.
   * Receives the change's `name`; the parent scopes a materialize to just that
   * change (re-generates source AND re-runs the dry-run). When absent, NO re-run
   * button renders (read-only / non-draft proposals).
   */
  onRerunChange?: (changeName: string) => void;
  /**
   * The change name whose re-run is currently in flight, if any — shows a
   * spinner on that change's button while it materializes.
   */
  rerunningChange?: string | null;
  /**
   * When true, ALL re-run buttons are disabled — another card-level action is in
   * flight. The spinner still shows only on the change named by `rerunningChange`.
   */
  disabled?: boolean;
}) {
  if (changes.length === 0) return null;

  return (
    <div className="space-y-2" data-testid="dry-run-outcomes">
      <h5 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <ActivityIcon className="size-3.5" />
        {t("proposals.dryRunSection", "Execution dry-run")}
      </h5>
      <p className="text-[11px] text-muted-foreground">
        {t(
          "proposals.dryRunHint",
          "Sandbox results from running the generated handler against synthetic inputs. Advisory only — a failing dry-run does not block graduation unless strictExecutionDryRun is on.",
        )}
      </p>
      {changes.map((c) => (
        <DryRunChangeRow
          key={`${c.target}:${c.operation}:${c.name}`}
          change={c}
          t={t}
          onRerunChange={onRerunChange}
          rerunningChange={rerunningChange}
          disabled={disabled}
        />
      ))}
    </div>
  );
}
