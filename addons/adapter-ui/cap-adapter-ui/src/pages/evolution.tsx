/**
 * Evolution History Page — /admin/evolution
 *
 * Timeline of all AI-driven changes that were approved and applied.
 * Shows: what changed, when, who approved, AI's reasoning.
 * Revert button for each reversible change.
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
import { Link } from "@tanstack/react-router";
import {
  AlertTriangleIcon,
  BotIcon,
  CheckCircle2,
  ClockIcon,
  CodeIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  HistoryIcon,
  Loader2Icon,
  PlayIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  UserIcon,
  XCircleIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { NlRuleDrafter } from "@/components/nl-rule-drafter";
import { SchedulerStatusPanel } from "@/components/scheduler-status-panel";
import {
  type EvolutionEntry,
  fetchEvolutionHistory,
  type RunEvolutionCycleResult,
  runEvolutionCycle,
} from "@/lib/proposal-api";

// ── Change type badge ────────────────────────────────────

function ChangeTypeBadge({ changeType }: { changeType: string }) {
  const colors: Record<string, string> = {
    patch: "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300",
    minor: "bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300",
    major: "bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300",
  };

  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${colors[changeType] ?? ""}`}
    >
      {changeType}
    </span>
  );
}

// ── Timeline item ────────────────────────────────────────

function TimelineItem({ entry, isLast }: { entry: EvolutionEntry; isLast: boolean }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="relative flex gap-4">
      {/* Timeline line */}
      <div className="flex flex-col items-center">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 border-primary bg-background z-10">
          {entry.authorType === "ai" ? (
            <BotIcon className="h-5 w-5 text-purple-500" />
          ) : (
            <UserIcon className="h-5 w-5 text-blue-500" />
          )}
        </div>
        {!isLast && <div className="w-0.5 flex-1 bg-border" />}
      </div>

      {/* Content */}
      <div className="flex-1 pb-8">
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between">
              <div>
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  {entry.title}
                  <ChangeTypeBadge changeType={entry.changeType} />
                  {entry.version && (
                    <Badge variant="outline" className="text-[10px] gap-1">
                      <GitBranchIcon className="h-3 w-3" />v{entry.version}
                    </Badge>
                  )}
                </CardTitle>
                <CardDescription className="mt-1">{entry.description}</CardDescription>
              </div>
              {entry.canRevert && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs text-muted-foreground hover:text-foreground shrink-0"
                >
                  <RotateCcwIcon className="h-3 w-3 mr-1" />
                  {t("evolution.revert")}
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* Meta */}
            <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <ClockIcon className="h-3 w-3" />
                {new Date(entry.appliedAt).toLocaleDateString()}{" "}
                {new Date(entry.appliedAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
              <span className="flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3" />
                {t("evolution.approvedBy")}: {entry.approvedBy}
              </span>
              <span className="flex items-center gap-1">
                <CodeIcon className="h-3 w-3" />
                {entry.capability}
              </span>
              <span className="flex items-center gap-1">
                {entry.authorType === "ai" ? (
                  <BotIcon className="h-3 w-3" />
                ) : (
                  <UserIcon className="h-3 w-3" />
                )}
                {entry.authorName}
              </span>
            </div>

            {/* AI Reasoning */}
            <div className="rounded-md bg-muted/50 p-3">
              <h5 className="text-xs font-medium text-muted-foreground mb-1">
                {t("evolution.reasoning")}
              </h5>
              <p className="text-sm">{entry.reasoning}</p>
            </div>

            {/* Changes (expandable) */}
            <div>
              <button
                type="button"
                className="text-xs text-primary hover:underline flex items-center gap-1"
                onClick={() => setExpanded(!expanded)}
              >
                {expanded
                  ? t("list.showLess")
                  : t("evolution.showChanges", { count: entry.changes.length })}
              </button>
              {expanded && (
                <div className="mt-2 space-y-1">
                  {entry.changes.map((change, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: changes have no stable id
                    <div key={`${change.name}-${i}`} className="rounded border p-2 text-xs">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-[9px]">
                          {change.operation}
                        </Badge>
                        <span className="font-medium">{change.target}</span>
                        <span className="text-muted-foreground">/ {change.name}</span>
                      </div>
                      {change.diff && (
                        <p className="mt-1 text-muted-foreground font-mono bg-muted/30 rounded px-2 py-1">
                          {change.diff}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ── Run-cycle outcome line ───────────────────────────────

function RunCycleOutcome({
  result,
  t,
}: {
  result: RunEvolutionCycleResult;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  switch (result.kind) {
    case "ran":
      return (
        <div
          className="flex flex-wrap items-center gap-3 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700 dark:border-green-900 dark:bg-green-950/30 dark:text-green-300"
          data-testid="run-cycle-ran"
        >
          <CheckCircle2 className="size-4 shrink-0" />
          <span>
            {t("evolution.runCycle.summary", {
              created: result.created,
              deduped: result.deduped,
              total: result.total,
              defaultValue: "Created {{created}} draft(s), {{deduped}} deduped ({{total}} total)",
            })}
          </span>
          {/* Route the reviewer to the human-gated review surface. */}
          <Link to={"/admin/proposals" as "/"}>
            <Button variant="outline" size="sm" className="h-7 gap-1 text-xs">
              <ExternalLinkIcon className="size-3" />
              {t("evolution.runCycle.reviewLink", "Review proposals")}
            </Button>
          </Link>
        </div>
      );

    case "unavailable":
      return (
        <div
          className="flex items-center gap-2 rounded-md border border-dashed bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
          data-testid="run-cycle-unavailable"
        >
          <AlertTriangleIcon className="size-4 shrink-0" />
          <span>
            {result.message ?? t("evolution.runCycle.unavailable", "Evolution cycle not available")}
          </span>
        </div>
      );

    case "denied":
      return (
        <div
          className="flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
          data-testid="run-cycle-denied"
        >
          <XCircleIcon className="size-4 shrink-0" />
          <span>{t("evolution.runCycle.denied", "Not authorized")}</span>
        </div>
      );

    case "error":
      return (
        <div
          className="flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
          data-testid="run-cycle-error"
        >
          <AlertTriangleIcon className="size-4 shrink-0" />
          <span>{result.message}</span>
        </div>
      );
  }
}

// ── Main Page ────────────────────────────────────────────

export function EvolutionPage() {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<EvolutionEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<RunEvolutionCycleResult | null>(null);

  const loadHistory = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchEvolutionHistory();
      setEntries(data);
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleRunCycle = useCallback(async () => {
    if (running) return;
    setRunning(true);
    setRunResult(null);
    try {
      const result = await runEvolutionCycle();
      setRunResult(result);
    } catch (err) {
      // runEvolutionCycle maps transport errors internally; this defensive catch
      // keeps an unexpected throw from becoming an unhandled rejection.
      setRunResult({
        kind: "error",
        message: err instanceof Error ? err.message : "Evolution cycle failed",
      });
    } finally {
      setRunning(false);
    }
  }, [running]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  return (
    <div className="p-4 space-y-4">
      {/* Read-only heartbeat of the autonomous evolution cadence loop. Auto-polls
          so the operator can see at a glance whether the scheduler is alive. */}
      <SchedulerStatusPanel pollIntervalMs={15000} />

      {/* "说→有" — draft a governed rule from natural language. The draft enters
          the human-gated review pipeline; this surface never approves/applies. */}
      <NlRuleDrafter />

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button size="sm" onClick={() => void handleRunCycle()} disabled={running}>
          {running ? (
            <Loader2Icon className="mr-1 size-3.5 animate-spin" />
          ) : (
            <PlayIcon className="mr-1 size-3.5" />
          )}
          {t("evolution.runCycle.action", "Run Evolution Cycle")}
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          onClick={loadHistory}
          aria-label={t("common.refresh", "Refresh")}
        >
          <RefreshCwIcon className="h-4 w-4" />
        </Button>
      </div>

      {runResult && <RunCycleOutcome result={runResult} t={t} />}

      {/* Timeline */}
      {loading ? (
        <div className="space-y-6">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex gap-4">
              <Skeleton className="h-10 w-10 rounded-full shrink-0" />
              <div className="flex-1">
                <Skeleton className="h-32 w-full rounded-lg" />
              </div>
            </div>
          ))}
        </div>
      ) : entries.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <HistoryIcon className="h-12 w-12 text-muted-foreground mx-auto mb-3 opacity-50" />
            <p className="text-sm text-muted-foreground">{t("evolution.noHistory")}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="relative">
          {entries.map((entry, i) => (
            <TimelineItem key={entry.id} entry={entry} isLast={i === entries.length - 1} />
          ))}
        </div>
      )}
    </div>
  );
}
