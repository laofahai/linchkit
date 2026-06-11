/**
 * FailedMaterializationChanges — renders the DURABLE materialization-failure
 * signal on the proposal review page.
 *
 * When an AI-materialized change FAILS the build/syntax gate it has no
 * `generatedSource`; instead it carries `materializationStatus:"failed"` plus the
 * gate errors in `materializationErrors`. The review page otherwise only renders
 * changes that SUCCEEDED, so a reviewer would never see WHICH changes failed code
 * generation or WHY. This presentational component surfaces that durably.
 *
 * Extracted from `proposal-review.tsx` to keep that page under the file-size
 * policy. Purely presentational — it never triggers a mutation.
 */

import { Button } from "@linchkit/ui-kit/components";
import { AlertTriangleIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";
import type { useTranslation } from "react-i18next";
import type { ProposalChange } from "@/lib/proposal-api";

type TFn = ReturnType<typeof useTranslation>["t"];

export function FailedMaterializationChanges({
  changes,
  t,
  onRetryChange,
  retryingChange,
  disabled,
}: {
  changes: readonly ProposalChange[];
  t: TFn;
  /**
   * Optional callback raised when the reviewer clicks "re-generate" on a failed
   * change. Receives the change's `name`; the parent scopes a materialize to just
   * that change. When absent, NO retry button renders (back-compat / read-only).
   */
  onRetryChange?: (changeName: string) => void;
  /**
   * The change name whose re-generate is currently in flight, if any — used to
   * show a spinner on that change's button while it materializes.
   */
  retryingChange?: string | null;
  /**
   * When true, ALL retry buttons are disabled — a card-level action (approve /
   * reject / graduate / materialize, or another retry) is in flight. Prevents
   * concurrent mutations / overlapping materialize calls. The spinner still
   * shows only on the change named by `retryingChange`.
   */
  disabled?: boolean;
}) {
  if (changes.length === 0) return null;

  return (
    <div className="space-y-2" data-testid="materialize-failed-changes">
      <h5 className="flex items-center gap-1.5 text-xs font-medium text-destructive">
        <AlertTriangleIcon className="size-3.5" />
        {t("proposals.materializeFailedChanges", "Generation failed (build gate)")}
      </h5>
      <p className="text-[11px] text-muted-foreground">
        {t(
          "proposals.materializeFailedHint",
          "These changes' AI-generated code did not pass the build gate. Review the errors; no candidate source was attached.",
        )}
      </p>
      {changes.map((c) => (
        <div
          key={`${c.target}:${c.operation}:${c.name}`}
          className="rounded-md border border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/30"
        >
          <div className="flex items-center gap-2 px-3 py-2 text-xs font-medium">
            <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-destructive">
              {t("proposals.materializeFailedBadge", "failed")}
            </span>
            <span className="min-w-0 flex-1 truncate">
              {c.target}/{c.name}
            </span>
            {/* Per-change retry — scopes a materialize to JUST this change so the
                reviewer can re-generate one failed change without regenerating the
                already-good ones. Purely raises the callback; the parent calls the
                API. Absent callback → no button (back-compat / read-only). */}
            {onRetryChange && (
              <Button
                size="sm"
                variant="outline"
                className="h-6 shrink-0 px-2 text-[11px]"
                onClick={() => onRetryChange(c.name)}
                // Disable every retry button while ANY card action or retry is in
                // flight (`disabled` covers approve/reject/graduate/materialize via
                // `busy`; `retryingChange` covers a sibling retry). `!!retryingChange`
                // (not `!== null`) so an omitted optional prop (undefined) does NOT
                // disable the button. Spinner below still shows only on the change
                // actually re-generating.
                disabled={disabled || !!retryingChange}
              >
                {retryingChange === c.name ? (
                  <Loader2Icon className="mr-1 size-3 animate-spin" />
                ) : (
                  <RefreshCwIcon className="mr-1 size-3" />
                )}
                {t("proposals.materializeRetryChange", "Re-generate")}
              </Button>
            )}
          </div>
          {c.materializationErrors && c.materializationErrors.length > 0 && (
            // A <div> (not <pre>) so the JSX indentation between the mapped <code>
            // elements is not preserved as literal whitespace in the DOM. `font-mono`
            // keeps the monospace look; `whitespace-pre-wrap` on each line preserves
            // the error text's own spacing while still wrapping long lines.
            <div className="overflow-x-auto border-t border-red-200 px-3 py-2 font-mono text-[11px] leading-relaxed dark:border-red-900">
              {c.materializationErrors.map((err, i) => (
                // Errors have no stable id; index keys are fine for this static list.
                // biome-ignore lint/suspicious/noArrayIndexKey: gate errors are a static, append-only list with no id
                <code key={i} className="block whitespace-pre-wrap">
                  {err}
                </code>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
