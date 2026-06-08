/**
 * Proposal review outcome renderers.
 *
 * Presentational components that render the result of the two human-triggered
 * mutations on the proposal review page: graduating an approved proposal into a
 * GitHub PR, and materializing AI-generated candidate source onto a draft.
 *
 * Extracted from `proposal-review.tsx` to keep that page under the file-size
 * policy. These are purely presentational — they never trigger a mutation.
 */

import { AlertTriangleIcon, CheckCircle2Icon, ExternalLinkIcon, XCircleIcon } from "lucide-react";
import type { useTranslation } from "react-i18next";
import type { GraduateProposalResult, MaterializeProposalResult } from "@/lib/proposal-api";

type TFn = ReturnType<typeof useTranslation>["t"];

// ── Graduate outcome renderer ─────────────────────────────

export function GraduateOutcome({ result, t }: { result: GraduateProposalResult; t: TFn }) {
  switch (result.kind) {
    case "ok":
      return (
        <div
          className="flex items-start gap-2 rounded-md border border-green-200 bg-green-50 p-3 dark:border-green-900 dark:bg-green-950/30"
          data-testid="graduate-ok"
        >
          <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-green-500" />
          <div className="space-y-1">
            <p className="text-sm text-green-700 dark:text-green-300">
              {t("proposals.graduatePrOpened", "Pull request opened for review.")}
            </p>
            {result.prUrl && (
              <a
                href={result.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                <ExternalLinkIcon className="size-3" />
                {t("proposals.viewPr", "View PR")}
              </a>
            )}
          </div>
        </div>
      );

    case "unavailable":
      return (
        <div
          className="flex items-start gap-2 rounded-md border border-dashed bg-muted/40 p-3"
          data-testid="graduate-unavailable"
        >
          <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            {result.message ?? t("proposals.graduateNotConfigured", "Graduation not configured.")}
          </p>
        </div>
      );

    case "denied":
      return (
        <div
          className="flex items-start gap-2 rounded-md bg-destructive/10 p-3"
          data-testid="graduate-denied"
        >
          <XCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
          <p className="text-sm text-destructive">
            {t("proposals.notAuthorized", "Not authorized.")}
          </p>
        </div>
      );

    case "not_approved":
      return (
        <div
          className="flex items-start gap-2 rounded-md bg-destructive/10 p-3"
          data-testid="graduate-not-approved"
        >
          <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
          <p className="text-sm text-destructive">
            {result.message ?? t("proposals.notApproved", "Proposal is not approved.")}
          </p>
        </div>
      );

    case "not_found":
      return (
        <div
          className="flex items-start gap-2 rounded-md bg-destructive/10 p-3"
          data-testid="graduate-not-found"
        >
          <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
          <p className="text-sm text-destructive">
            {t("proposals.notFound", "Proposal not found.")}
          </p>
        </div>
      );

    case "error":
      return (
        <div
          className="flex items-start gap-2 rounded-md bg-destructive/10 p-3"
          data-testid="graduate-error"
        >
          <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
          <p className="text-sm text-destructive">{result.message}</p>
        </div>
      );
  }
}

// ── Materialize outcome renderer ──────────────────────────

export function MaterializeOutcome({ result, t }: { result: MaterializeProposalResult; t: TFn }) {
  switch (result.kind) {
    case "ok": {
      const materialized = result.outcomes.filter((o) => o.status === "materialized").length;
      const skipped = result.outcomes.filter((o) => o.status === "skipped").length;
      const failed = result.outcomes.filter((o) => o.status === "failed").length;
      const ok = result.allMaterialized;
      return (
        <div
          className={`flex items-start gap-2 rounded-md border p-3 ${
            ok
              ? "border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/30"
              : "border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30"
          }`}
          data-testid="materialize-ok"
        >
          {ok ? (
            <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-green-500" />
          ) : (
            <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-amber-500" />
          )}
          <p className="text-sm">
            {t("proposals.materializeSummary", "Generated {{m}}, skipped {{s}}, failed {{f}}.", {
              m: materialized,
              s: skipped,
              f: failed,
            })}
          </p>
        </div>
      );
    }

    case "unavailable":
      return (
        <div
          className="flex items-start gap-2 rounded-md border border-dashed bg-muted/40 p-3"
          data-testid="materialize-unavailable"
        >
          <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            {result.message ??
              t("proposals.materializeNotConfigured", "AI code generation is not configured.")}
          </p>
        </div>
      );

    case "denied":
      return (
        <div
          className="flex items-start gap-2 rounded-md bg-destructive/10 p-3"
          data-testid="materialize-denied"
        >
          <XCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
          <p className="text-sm text-destructive">
            {t("proposals.notAuthorized", "Not authorized.")}
          </p>
        </div>
      );

    case "not_draft":
      return (
        <div
          className="flex items-start gap-2 rounded-md bg-destructive/10 p-3"
          data-testid="materialize-not-draft"
        >
          <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
          <p className="text-sm text-destructive">
            {result.message ?? t("proposals.notDraft", "Proposal is not a draft.")}
          </p>
        </div>
      );

    case "not_found":
      return (
        <div
          className="flex items-start gap-2 rounded-md bg-destructive/10 p-3"
          data-testid="materialize-not-found"
        >
          <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
          <p className="text-sm text-destructive">
            {t("proposals.notFound", "Proposal not found.")}
          </p>
        </div>
      );

    case "error":
      return (
        <div
          className="flex items-start gap-2 rounded-md bg-destructive/10 p-3"
          data-testid="materialize-error"
        >
          <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
          <p className="text-sm text-destructive">{result.message}</p>
        </div>
      );
  }
}
