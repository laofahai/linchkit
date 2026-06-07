/**
 * ProposalReviewPage — `/admin/proposals`.
 *
 * The real human-gated proposal review surface for the evolution governance
 * loop. Lists governed Proposals, lets a human approve / reject pending ones,
 * and graduate an approved one (write files + open a GitHub PR for review).
 *
 * Hard rule ("AI Never Modifies Production Directly"): every mutation here is an
 * EXPLICIT user click. Graduation only ever opens a PR — it NEVER merges. The
 * UI never auto-approves or auto-graduates anything.
 */

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Skeleton,
} from "@linchkit/ui-kit/components";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  ClipboardListIcon,
  ExternalLinkIcon,
  GitPullRequestIcon,
  Loader2Icon,
  RefreshCwIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  XCircleIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  approveProposal,
  fetchProposals,
  type GraduateProposalResult,
  graduateProposal,
  type Proposal,
  rejectProposal,
} from "@/lib/proposal-api";
import {
  canGraduate,
  changeTypeBadgeClass,
  isPending,
  PROPOSAL_STATUS_FILTERS,
  type ProposalStatusFilter,
  statusBadgeClass,
} from "./proposal-review-helpers";

// ── Per-proposal action card ──────────────────────────────

function ProposalCard({
  proposal,
  onChanged,
  t,
}: {
  proposal: Proposal;
  onChanged: () => void;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [grad, setGrad] = useState<GraduateProposalResult | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const handleApprove = useCallback(async () => {
    setBusy(true);
    setActionError(null);
    try {
      await approveProposal(proposal.id);
      onChanged();
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : t("proposals.approveFailed", "Approve failed"),
      );
    } finally {
      setBusy(false);
    }
  }, [proposal.id, onChanged, t]);

  const handleReject = useCallback(async () => {
    const trimmed = reason.trim();
    if (!trimmed) return;
    setBusy(true);
    setActionError(null);
    try {
      await rejectProposal(proposal.id, trimmed);
      setRejecting(false);
      setReason("");
      onChanged();
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : t("proposals.rejectFailed", "Reject failed"),
      );
    } finally {
      setBusy(false);
    }
  }, [proposal.id, reason, onChanged, t]);

  const handleGraduate = useCallback(async () => {
    setBusy(true);
    setActionError(null);
    setGrad(null);
    try {
      // graduateProposal is designed to never throw (it maps every failure to a
      // discriminated result), but wrap it defensively so an unexpected throw
      // still surfaces as an error outcome and never leaves the button stuck
      // disabled. Mirrors handleRunCycle on the Evolution page.
      const result = await graduateProposal(proposal.id);
      setGrad(result);
    } catch (err) {
      setGrad({
        kind: "error",
        message:
          err instanceof Error ? err.message : t("proposals.graduateFailed", "Graduation failed"),
      });
    } finally {
      setBusy(false);
    }
    // Do NOT auto-refresh on success: reloading the list would unmount this card
    // (or, under the `approved` filter, remove it entirely / remount it as
    // `committed`) and discard the rendered PR link before the reviewer can open
    // it. The success outcome — including "View PR" — stays visible, and the
    // Graduate button is hidden below to prevent a second submission. The user
    // refreshes the list manually when ready.
  }, [proposal.id, t]);

  const pending = isPending(proposal.status);
  const graduatable = canGraduate(proposal.status);

  return (
    <Card data-testid="proposal-card">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="text-sm font-medium flex flex-wrap items-center gap-2">
              <span className="truncate">{proposal.title}</span>
              <Badge
                variant="outline"
                className={`text-[10px] font-semibold uppercase ${statusBadgeClass(proposal.status)}`}
              >
                {proposal.status}
              </Badge>
              <Badge
                variant="outline"
                className={`text-[10px] font-semibold uppercase ${changeTypeBadgeClass(proposal.changeType)}`}
              >
                {proposal.changeType}
              </Badge>
            </CardTitle>
            {proposal.description && (
              <CardDescription className="mt-1">{proposal.description}</CardDescription>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Meta */}
        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
          <span>
            {t("proposals.capability", "Capability")}:{" "}
            <span className="font-medium">{proposal.capability}</span>
          </span>
          <span>
            {t("proposals.author", "Author")}:{" "}
            <span className="font-medium">{proposal.author.name}</span>
          </span>
        </div>

        {/* Impact summary, if present */}
        {proposal.validationResult?.impactSummary && (
          <div className="rounded-md bg-muted/50 p-3">
            <h5 className="text-xs font-medium text-muted-foreground mb-1">
              {t("proposals.impact", "Impact")}
            </h5>
            <p className="text-sm">{proposal.validationResult.impactSummary}</p>
          </div>
        )}

        {/* Generic action error */}
        {actionError && (
          <div className="flex items-start gap-2 rounded-md bg-destructive/10 p-2 text-sm text-destructive">
            <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
            <span>{actionError}</span>
          </div>
        )}

        {/* Pending: approve / reject */}
        {pending && (
          <div className="space-y-2">
            {rejecting ? (
              <div className="space-y-2">
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder={t("proposals.rejectReason", "Reason for rejection")}
                  aria-label={t("proposals.rejectReason", "Reason for rejection")}
                  rows={2}
                  className="w-full resize-none rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                  disabled={busy}
                />
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => void handleReject()}
                    disabled={busy || reason.trim().length === 0}
                  >
                    {busy ? (
                      <Loader2Icon className="mr-1 size-3.5 animate-spin" />
                    ) : (
                      <ThumbsDownIcon className="mr-1 size-3.5" />
                    )}
                    {t("proposals.confirmReject", "Confirm reject")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setRejecting(false);
                      setReason("");
                    }}
                    disabled={busy}
                  >
                    {t("common.cancel", "Cancel")}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex gap-2">
                <Button size="sm" onClick={() => void handleApprove()} disabled={busy}>
                  {busy ? (
                    <Loader2Icon className="mr-1 size-3.5 animate-spin" />
                  ) : (
                    <ThumbsUpIcon className="mr-1 size-3.5" />
                  )}
                  {t("proposals.approve", "Approve")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setRejecting(true)}
                  disabled={busy}
                >
                  <ThumbsDownIcon className="mr-1 size-3.5" />
                  {t("proposals.reject", "Reject")}
                </Button>
              </div>
            )}
          </div>
        )}

        {/* Approved: graduate → open PR (never merges). Once a PR is opened the
            button + hint are hidden so the success outcome (with the PR link)
            survives and a second graduation can't be triggered. */}
        {graduatable && (
          <div className="space-y-2">
            {grad?.kind !== "ok" && (
              <>
                <Button size="sm" onClick={() => void handleGraduate()} disabled={busy}>
                  {busy ? (
                    <Loader2Icon className="mr-1 size-3.5 animate-spin" />
                  ) : (
                    <GitPullRequestIcon className="mr-1 size-3.5" />
                  )}
                  {t("proposals.graduate", "Graduate → open PR")}
                </Button>
                <p className="text-[11px] text-muted-foreground">
                  {t(
                    "proposals.graduateHint",
                    "Writes the definition files and opens a GitHub PR for review. It never merges.",
                  )}
                </p>
              </>
            )}
            {grad && <GraduateOutcome result={grad} t={t} />}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Graduate outcome renderer ─────────────────────────────

function GraduateOutcome({
  result,
  t,
}: {
  result: GraduateProposalResult;
  t: ReturnType<typeof useTranslation>["t"];
}) {
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

// ── Page ──────────────────────────────────────────────────

export function ProposalReviewPage() {
  const { t } = useTranslation();
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<ProposalStatusFilter>("all");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const status = filter === "all" ? undefined : filter;
      const data = await fetchProposals(status);
      setProposals(data.items);
    } catch {
      setProposals([]);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="p-4 space-y-4 max-w-4xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold flex items-center gap-2">
          <ClipboardListIcon className="size-4 text-primary" />
          {t("proposals.title", "Proposal Review")}
        </h2>
        <div className="flex items-center gap-2">
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as ProposalStatusFilter)}
            aria-label={t("proposals.statusFilter", "Status filter")}
            className="rounded-md border bg-background px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          >
            {PROPOSAL_STATUS_FILTERS.map((s) => (
              <option key={s} value={s}>
                {t(`proposals.status.${s}`, s)}
              </option>
            ))}
          </select>
          <Button
            variant="outline"
            size="icon-sm"
            onClick={load}
            aria-label={t("common.refresh", "Refresh")}
          >
            <RefreshCwIcon className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-40 w-full rounded-lg" />
          ))}
        </div>
      ) : proposals.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <ClipboardListIcon className="h-12 w-12 text-muted-foreground mx-auto mb-3 opacity-50" />
            <p className="text-sm text-muted-foreground">
              {t("proposals.empty", "No proposals to review.")}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {proposals.map((p) => (
            <ProposalCard key={p.id} proposal={p} onChanged={load} t={t} />
          ))}
        </div>
      )}
    </div>
  );
}
