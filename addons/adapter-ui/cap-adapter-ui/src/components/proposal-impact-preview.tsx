/**
 * ProposalImpactPreview — Spec 55 §7.3 review panel.
 *
 * Renders the four pre-analysis stages (dedup, conflict, impact, backtest)
 * for a Proposal that has been run through the pre-analysis pipeline.
 *
 * Each stage is a collapsible Card section. Stages with status === "skipped"
 * or no data render a muted placeholder. Stages with errors surface the
 * error code + message. The component is purely presentational — it never
 * invokes the analyzer pipeline itself.
 *
 * Closes the last open deliverable on Spec 55 §7.3.
 */

import type {
  BacktestResult,
  ConflictResult,
  DedupResult,
  ImpactResult,
  PreAnalysisStage,
  PreAnalysisStageResult,
  ProposalPreAnalysisResult,
} from "@linchkit/core";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@linchkit/ui-kit/components";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  DatabaseIcon,
  GitMergeIcon,
  HistoryIcon,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { STAGE_ORDER, type Tone, toneForStatus } from "./proposal-impact-preview-helpers";
import {
  BacktestView,
  ConflictView,
  DedupView,
  ErrorBlock,
  ImpactView,
  MutedPlaceholder,
  TONE_BORDER_CLASS,
} from "./proposal-impact-preview-stages";

// ── Component props ────────────────────────────────────────

export interface ProposalImpactPreviewProps {
  /** Pre-analysis result. Pass null/undefined to render an empty placeholder. */
  result: ProposalPreAnalysisResult | null | undefined;
  /** Optional className for outer wrapper. */
  className?: string;
}

// ── Tone → badge class (status pill colours) ───────────────

const TONE_BADGE_CLASS: Record<Tone, string> = {
  error: "bg-destructive/10 text-destructive border-destructive/30",
  warning: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30",
  success: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30",
  info: "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/30",
  muted: "bg-muted text-muted-foreground border-border",
};

// ── Stage icons ────────────────────────────────────────────

const STAGE_ICON: Record<PreAnalysisStage, typeof CopyIcon> = {
  dedup: CopyIcon,
  conflict: GitMergeIcon,
  impact: DatabaseIcon,
  backtest: HistoryIcon,
};

// ── Status badge ───────────────────────────────────────────

function StatusBadge({ status }: { status: PreAnalysisStageResult["status"] | undefined }) {
  const { t } = useTranslation();
  const tone = toneForStatus(status);
  const labelKey =
    status === "ok"
      ? "proposals.preanalysis.status.ok"
      : status === "error"
        ? "proposals.preanalysis.status.error"
        : status === "skipped"
          ? "proposals.preanalysis.status.skipped"
          : "proposals.preanalysis.status.notRun";
  return (
    <Badge variant="outline" className={`text-[10px] ${TONE_BADGE_CLASS[tone]}`}>
      {t(labelKey)}
    </Badge>
  );
}

// ── Stage shell (collapsible card around each stage) ───────

function StageShell({
  stage,
  envelope,
  children,
}: {
  stage: PreAnalysisStage;
  envelope: PreAnalysisStageResult | undefined;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  const Icon = STAGE_ICON[stage];
  const tone = toneForStatus(envelope?.status);
  const titleKey = `proposals.preanalysis.stages.${stage}.title`;

  return (
    <Card className={`border-l-4 ${TONE_BORDER_CLASS[tone]}`}>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer pb-3 hover:bg-muted/30 transition-colors">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2 text-sm font-medium">
                {open ? (
                  <ChevronDownIcon className="h-3.5 w-3.5 text-muted-foreground" />
                ) : (
                  <ChevronRightIcon className="h-3.5 w-3.5 text-muted-foreground" />
                )}
                <Icon className="h-4 w-4 text-muted-foreground" />
                {t(titleKey)}
              </CardTitle>
              <div className="flex items-center gap-2">
                <StatusBadge status={envelope?.status} />
                {envelope?.durationMs !== undefined && (
                  <span className="text-[10px] text-muted-foreground">
                    {Math.round(envelope.durationMs)}ms
                  </span>
                )}
              </div>
            </div>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="pt-0 text-sm">{children}</CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

// ── Stage render dispatcher ────────────────────────────────

function StageBody({
  stage,
  envelope,
}: {
  stage: PreAnalysisStage;
  envelope: PreAnalysisStageResult | undefined;
}) {
  if (!envelope) {
    return <MutedPlaceholder messageKey={`proposals.preanalysis.stages.${stage}.notRun`} />;
  }
  if (envelope.status === "skipped") {
    return <MutedPlaceholder messageKey={`proposals.preanalysis.stages.${stage}.skipped`} />;
  }
  if (envelope.status === "error") {
    return <ErrorBlock envelope={envelope} />;
  }
  if (!envelope.data) {
    return <MutedPlaceholder messageKey={`proposals.preanalysis.stages.${stage}.noData`} />;
  }

  switch (stage) {
    case "dedup":
      return <DedupView data={envelope.data as DedupResult} />;
    case "conflict":
      return <ConflictView data={envelope.data as ConflictResult} />;
    case "impact":
      return <ImpactView data={envelope.data as ImpactResult} />;
    case "backtest":
      return <BacktestView data={envelope.data as BacktestResult} />;
    default:
      return null;
  }
}

// ── Main component ─────────────────────────────────────────

export function ProposalImpactPreview({ result, className }: ProposalImpactPreviewProps) {
  const { t } = useTranslation();

  if (!result) {
    return (
      <Card className={className}>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          {t("proposals.preanalysis.empty")}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className={`space-y-3 ${className ?? ""}`}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">{t("proposals.preanalysis.heading")}</h3>
        <span className="text-[11px] text-muted-foreground">
          {new Date(result.analyzedAt).toLocaleString()}
        </span>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {Math.round(result.totalDurationMs)}ms
        </span>
      </div>
      {STAGE_ORDER.map((stage) => (
        <StageShell key={stage} stage={stage} envelope={result.stages[stage]}>
          <StageBody stage={stage} envelope={result.stages[stage]} />
        </StageShell>
      ))}
    </div>
  );
}
