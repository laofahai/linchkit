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

import { AlertTriangleIcon } from "lucide-react";
import type { useTranslation } from "react-i18next";
import type { ProposalChange } from "@/lib/proposal-api";

type TFn = ReturnType<typeof useTranslation>["t"];

export function FailedMaterializationChanges({
  changes,
  t,
}: {
  changes: readonly ProposalChange[];
  t: TFn;
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
            <span className="truncate">
              {c.target}/{c.name}
            </span>
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
