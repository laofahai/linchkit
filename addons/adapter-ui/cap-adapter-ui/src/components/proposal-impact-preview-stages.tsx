/**
 * Per-stage subviews for ProposalImpactPreview (Spec 55 §7.3).
 *
 * Pulled out of the main component file to keep each module under the
 * 300-line cap. The shared tone → tailwind class maps live alongside the
 * helpers; everything here is pure JSX that renders one stage's payload.
 */

import type {
  BacktestResult,
  ConflictFinding,
  ConflictResult,
  DedupResult,
  ImpactResult,
  PreAnalysisStageResult,
} from "@linchkit/core";
import { Badge } from "@linchkit/ui-kit/components";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  MinusCircleIcon,
  ShieldAlertIcon,
  XCircleIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { groupConflicts, toneForConflict } from "./proposal-impact-preview-helpers";

// ── Tone → border class (also used by the parent for stage borders) ─────

export const TONE_BORDER_CLASS = {
  error: "border-l-destructive",
  warning: "border-l-amber-500",
  success: "border-l-emerald-500",
  info: "border-l-blue-500",
  muted: "border-l-muted-foreground/40",
} as const;

// ── Placeholder + error blocks ─────────────────────────────

export function MutedPlaceholder({ messageKey }: { messageKey: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <MinusCircleIcon className="h-3.5 w-3.5" />
      <span>{t(messageKey)}</span>
    </div>
  );
}

export function ErrorBlock({ envelope }: { envelope: PreAnalysisStageResult }) {
  const { t } = useTranslation();
  const code = envelope.error?.code ?? "UNKNOWN";
  const message = envelope.error?.message ?? t("proposals.preanalysis.unknownError");
  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
      <div className="flex items-start gap-2">
        <XCircleIcon className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
        <div className="text-xs">
          <div className="font-mono text-destructive">{code}</div>
          <div className="mt-1 text-foreground">{message}</div>
        </div>
      </div>
    </div>
  );
}

// ── Dedup view ─────────────────────────────────────────────

export function DedupView({ data }: { data: DedupResult }) {
  const { t } = useTranslation();
  const hasExact = data.exactMatch !== null;
  const similarCount = data.similar.length;

  if (!hasExact && similarCount === 0) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <CheckCircle2Icon className="h-3.5 w-3.5 text-emerald-500" />
        <span>{t("proposals.preanalysis.stages.dedup.empty")}</span>
        <span className="ml-auto font-mono text-[10px]">{data.payloadHash}</span>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {hasExact && data.exactMatch && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
          <div className="flex items-start gap-2">
            <ShieldAlertIcon className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
            <div className="text-xs">
              <div className="font-medium text-destructive">
                {t("proposals.preanalysis.stages.dedup.exactMatchBanner")}
              </div>
              <div className="mt-1 text-foreground">
                <span className="font-mono">{data.exactMatch.id}</span>
                {" — "}
                {data.exactMatch.title}
              </div>
            </div>
          </div>
        </div>
      )}
      {similarCount > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground">
            {t("proposals.preanalysis.stages.dedup.similarHeader", { count: similarCount })}
          </div>
          <ul className="space-y-1">
            {data.similar.map((p) => (
              <li
                key={p.id}
                className="flex items-center gap-2 rounded border bg-muted/30 px-2 py-1.5 text-xs"
              >
                <span className="font-mono text-muted-foreground">{p.id}</span>
                <span className="truncate">{p.title}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="text-[10px] text-muted-foreground font-mono">
        {t("proposals.preanalysis.stages.dedup.payloadHash")}: {data.payloadHash}
      </div>
    </div>
  );
}

// ── Conflict view ──────────────────────────────────────────

function ConflictGroup({
  kind,
  findings,
}: {
  kind: ConflictFinding["kind"];
  findings: ConflictFinding[];
}) {
  const { t } = useTranslation();
  if (findings.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium text-muted-foreground">
        {t(`proposals.preanalysis.stages.conflict.kinds.${kind}`)} · {findings.length}
      </div>
      <ul className="space-y-1">
        {findings.map((f, idx) => {
          const tone = toneForConflict(f);
          return (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: findings have no stable id
              key={`${f.kind}-${f.targetId}-${idx}`}
              className={`flex items-start gap-2 rounded border-l-2 ${TONE_BORDER_CLASS[tone]} bg-muted/30 px-2 py-1.5 text-xs`}
            >
              <AlertTriangleIcon
                className={`h-3.5 w-3.5 shrink-0 mt-0.5 ${
                  tone === "error" ? "text-destructive" : "text-amber-500"
                }`}
              />
              <div className="min-w-0 flex-1">
                <div className="font-mono text-muted-foreground">{f.targetId}</div>
                <div className="text-foreground">{f.message}</div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function ConflictView({ data }: { data: ConflictResult }) {
  const { t } = useTranslation();
  if (data.conflicts.length === 0) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <CheckCircle2Icon className="h-3.5 w-3.5 text-emerald-500" />
        <span>{t("proposals.preanalysis.stages.conflict.empty")}</span>
        {data.notes && <span className="ml-auto italic">{data.notes}</span>}
      </div>
    );
  }
  const grouped = groupConflicts(data.conflicts);
  return (
    <div className="space-y-3">
      <ConflictGroup kind="rule" findings={grouped.rule} />
      <ConflictGroup kind="state_transition" findings={grouped.state_transition} />
      <ConflictGroup kind="proposal" findings={grouped.proposal} />
      <ConflictGroup kind="other" findings={grouped.other} />
      {data.notes && <div className="text-[10px] italic text-muted-foreground">{data.notes}</div>}
    </div>
  );
}

// ── Impact view ────────────────────────────────────────────

export function ImpactView({ data }: { data: ImpactResult }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-semibold tabular-nums">{data.affectedRecordCount}</span>
        <span className="text-xs text-muted-foreground">
          {t("proposals.preanalysis.stages.impact.recordsAffected")}
        </span>
      </div>

      {data.reason && (
        <div className="rounded-md bg-muted/40 p-2 text-xs text-muted-foreground">
          {data.reason}
        </div>
      )}

      {data.probedEntities.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">
            {t("proposals.preanalysis.stages.impact.probedEntities")}:
          </span>
          {data.probedEntities.map((entity) => (
            <Badge key={entity} variant="outline" className="text-[10px] font-mono">
              {entity}
            </Badge>
          ))}
        </div>
      )}

      {data.sampleRecordIds.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-xs font-medium text-muted-foreground">
            {t("proposals.preanalysis.stages.impact.sample", {
              count: data.sampleRecordIds.length,
            })}
          </div>
          <ul className="flex flex-wrap gap-1">
            {data.sampleRecordIds.map((id) => (
              <li key={id} className="rounded border bg-muted/30 px-2 py-0.5 text-[11px] font-mono">
                {id}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ── Backtest view ──────────────────────────────────────────

export function BacktestView({ data }: { data: BacktestResult }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-md border bg-muted/30 p-3">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {t("proposals.preanalysis.stages.backtest.windowDays")}
          </div>
          <div className="mt-1 text-xl font-semibold tabular-nums">{data.windowDays}</div>
        </div>
        <div className="rounded-md border bg-muted/30 p-3">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {t("proposals.preanalysis.stages.backtest.triggers")}
          </div>
          <div className="mt-1 text-xl font-semibold tabular-nums">
            {data.hypotheticalTriggerCount}
          </div>
        </div>
      </div>
      {data.summary && <div className="rounded-md bg-muted/40 p-3 text-xs">{data.summary}</div>}
    </div>
  );
}
