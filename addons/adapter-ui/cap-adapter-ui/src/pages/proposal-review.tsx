/**
 * ProposalReviewPage — `/admin/proposals`.
 *
 * The real human-gated proposal review surface for the evolution governance
 * loop. Lists governed Proposals, lets a human approve / reject pending ones,
 * graduate an approved one (write files + open a GitHub PR for review), and
 * materialize / re-generate a draft's AI code candidates.
 *
 * Hard rule ("AI Never Modifies Production Directly"): every mutation here is an
 * EXPLICIT user click. Graduation only ever opens a PR — it NEVER merges. The UI
 * never auto-approves or auto-graduates anything.
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
  ClipboardListIcon,
  Code2Icon,
  GitPullRequestIcon,
  Loader2Icon,
  RefreshCwIcon,
  SparklesIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { DryRunOutcomesPanel } from "@/components/dry-run-outcomes";
import { FailedMaterializationChanges } from "@/components/proposal-failed-changes";
import { ProposalImpactPreview } from "@/components/proposal-impact-preview";
import { GraduateOutcome, MaterializeOutcome } from "@/components/proposal-review-outcomes";
import {
  approveProposal,
  fetchProposals,
  type GraduateProposalResult,
  graduateProposal,
  type MaterializeProposalResult,
  materializeProposal,
  type Proposal,
  type ProposalChange,
  rejectProposal,
} from "@/lib/proposal-api";
import {
  buildMaterializeScope,
  canGraduate,
  changeTypeBadgeClass,
  errorMessage,
  isPending,
  PROPOSAL_STATUS_FILTERS,
  type ProposalStatusFilter,
  selectDryRunChanges,
  selectFailedMaterializationChanges,
  selectSourcedChanges,
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
  const [mat, setMat] = useState<MaterializeProposalResult | null>(null);
  // Failed change name whose per-change "re-generate" is in flight, if any.
  const [retryingChange, setRetryingChange] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const handleApprove = useCallback(async () => {
    setBusy(true);
    setActionError(null);
    try {
      await approveProposal(proposal.id);
      onChanged();
    } catch (err) {
      setActionError(errorMessage(err, t("proposals.approveFailed", "Approve failed")));
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
      setActionError(errorMessage(err, t("proposals.rejectFailed", "Reject failed")));
    } finally {
      setBusy(false);
    }
  }, [proposal.id, reason, onChanged, t]);

  const handleGraduate = useCallback(async () => {
    setBusy(true);
    setActionError(null);
    setGrad(null);
    try {
      // graduateProposal maps every failure to a discriminated result; wrap
      // defensively so an unexpected throw still surfaces as an error outcome.
      // Mirrors handleRunCycle on the Evolution page.
      setGrad(await graduateProposal(proposal.id));
    } catch (err) {
      setGrad({
        kind: "error",
        message: errorMessage(err, t("proposals.graduateFailed", "Graduation failed")),
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

  const handleMaterialize = useCallback(async () => {
    setBusy(true);
    setActionError(null);
    setMat(null);
    try {
      // materializeProposal maps every failure to a discriminated result; wrap
      // defensively so an unexpected throw still surfaces. Mirrors handleGraduate.
      setMat(await materializeProposal(proposal.id));
    } catch (err) {
      setMat({
        kind: "error",
        message: errorMessage(err, t("proposals.materializeFailed", "Materialization failed")),
      });
    } finally {
      setBusy(false);
    }
    // Do NOT auto-refresh: the generated source is rendered from the returned
    // result so the reviewer sees it immediately. The draft stays a draft
    // server-side (the candidate source is persisted on it); a manual refresh
    // re-loads it via `proposal.changes`.
  }, [proposal.id, t]);

  // Re-generate ONE failed change (scope materialize to it); reuse handleMaterialize's
  // result path. `busy` blocks other actions/retries; `retryingChange` spins this button.
  const handleRetryChange = useCallback(
    async (changeName: string) => {
      setBusy(true);
      setRetryingChange(changeName);
      setActionError(null);
      try {
        setMat(await materializeProposal(proposal.id, buildMaterializeScope(changeName)));
      } catch (err) {
        setMat({
          kind: "error",
          message: errorMessage(err, t("proposals.materializeFailed", "Materialization failed")),
        });
      } finally {
        setRetryingChange(null);
        setBusy(false);
      }
    },
    [proposal.id, t],
  );

  const pending = isPending(proposal.status);
  const graduatable = canGraduate(proposal.status);
  const isDraft = proposal.status === "draft";
  // Prefer the freshly-materialized proposal's changes (if any) over the prop so
  // generated source / failure signals show immediately after a click without a
  // manual refresh.
  const renderedChanges: ProposalChange[] =
    (mat?.kind === "ok" && mat.proposal ? mat.proposal.changes : proposal.changes) ?? [];
  const sourcedChanges = selectSourcedChanges(renderedChanges);
  const failedChanges = selectFailedMaterializationChanges(renderedChanges);
  const dryRunChanges = selectDryRunChanges(renderedChanges);

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

        {/* Pre-analysis evidence (Spec 55 §7.3) — dedup / conflict / impact /
            backtest the AI ran before surfacing this proposal. Decision-support
            shown BEFORE the approve/reject controls; absent for manual drafts. */}
        {proposal.analysis && (
          <div data-testid="proposal-preanalysis">
            <ProposalImpactPreview result={proposal.analysis} />
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

        {/* Draft: materialize → AI-generate candidate source for the proposal's
            code parts and attach it to this draft. NEVER approves/applies — the
            candidate stays on the draft inside the human-gated review pipeline. */}
        {isDraft && (
          <div className="space-y-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void handleMaterialize()}
              disabled={busy}
            >
              {busy ? (
                <Loader2Icon className="mr-1 size-3.5 animate-spin" />
              ) : (
                <SparklesIcon className="mr-1 size-3.5" />
              )}
              {t("proposals.materialize", "Materialize code")}
            </Button>
            <p className="text-[11px] text-muted-foreground">
              {t(
                "proposals.materializeHint",
                "Uses AI to generate candidate source for this proposal's code parts and attaches it to the draft for review. It never approves or applies anything.",
              )}
            </p>
            {mat && <MaterializeOutcome result={mat} t={t} />}
          </div>
        )}

        {/* Generated candidate source (read-only). Present after materialization;
            shown for any proposal whose changes carry generatedSource. */}
        {sourcedChanges.length > 0 && (
          <div className="space-y-2" data-testid="generated-source">
            <h5 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Code2Icon className="size-3.5" />
              {t("proposals.generatedSource", "Generated source (candidate)")}
            </h5>
            {sourcedChanges.map((c) => (
              <details
                key={`${c.target}:${c.operation}:${c.name}`}
                className="rounded-md border bg-muted/30"
              >
                <summary className="cursor-pointer px-3 py-2 text-xs font-medium">
                  {c.target}/{c.name}
                </summary>
                <pre className="overflow-x-auto border-t px-3 py-2 text-[11px] leading-relaxed">
                  <code>{c.generatedSource}</code>
                </pre>
              </details>
            ))}
          </div>
        )}

        {/* Durable failure signal: changes that FAILED the build gate, each with a scoped retry. */}
        <FailedMaterializationChanges
          changes={failedChanges}
          t={t}
          // Retry calls materialize (DRAFT-ONLY) — only offer it on a draft; disable
          // all retry buttons while any card action is in flight (`busy`).
          onRetryChange={isDraft ? handleRetryChange : undefined}
          retryingChange={retryingChange}
          disabled={busy}
        />

        {/* Durable dry-run signal (Spec 70 P4): sandbox outcomes for materializable changes. */}
        <DryRunOutcomesPanel
          changes={dryRunChanges}
          t={t}
          // Re-run scopes a fresh materialize (re-gen + re-dry-run) to the one change.
          onRerunChange={isDraft ? handleRetryChange : undefined}
          rerunningChange={retryingChange}
          disabled={busy}
        />

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
