/**
 * SchedulerStatusPanel — read-only heartbeat for the autonomous-evolution
 * cadence loop.
 *
 * Polls `GET /api/evolution/scheduler-status` and visualizes whether the
 * cadence scheduler is alive: a status pill (Running / Idle / Disabled /
 * Unauthorized / Unavailable), the tick interval, ticks completed/started, the
 * last tick time + duration, and — on an error streak — a warning row with the
 * last error and consecutive-error count.
 *
 * Purely presentational + a fetch hook. It NEVER mutates anything: the only
 * network call is the read-only status GET, triggered on mount, on an optional
 * poll interval, and by a manual refresh button.
 */

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@linchkit/ui-kit/components";
import {
  ActivityIcon,
  AlertTriangleIcon,
  CheckCircle2,
  Loader2Icon,
  PauseCircleIcon,
  PowerOffIcon,
  RefreshCwIcon,
  XCircleIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchSchedulerStatus, type SchedulerStatusResult } from "@/lib/evolution-api";
import {
  formatTimestamp,
  hasErrorStreak,
  humanizeMs,
  type SchedulerTone,
  toSchedulerStatusView,
} from "./scheduler-status-panel-helpers";

// ── Pill tone → classes + icon ─────────────────────────────

const TONE_PILL_CLASS: Record<SchedulerTone, string> = {
  running: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  idle: "border-border bg-muted text-muted-foreground",
  disabled: "border-border bg-muted text-muted-foreground",
  denied: "border-destructive/30 bg-destructive/10 text-destructive",
  error: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
};

const TONE_ICON: Record<SchedulerTone, typeof ActivityIcon> = {
  running: ActivityIcon,
  idle: PauseCircleIcon,
  disabled: PowerOffIcon,
  denied: XCircleIcon,
  error: AlertTriangleIcon,
};

// ── Props ──────────────────────────────────────────────────

export interface SchedulerStatusPanelProps {
  /**
   * Auto-poll interval in ms. When > 0, the panel refetches on a timer and
   * cleans the timer up on unmount. Defaults to 0 (no auto-poll — manual only).
   */
  pollIntervalMs?: number;
  /** Optional fetch override (tests inject a stub; never used in production). */
  fetchImpl?: typeof fetch;
  /** Optional className for the outer Card. */
  className?: string;
}

// ── A single detail row ────────────────────────────────────

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}

// ── Component ──────────────────────────────────────────────

export function SchedulerStatusPanel({
  pollIntervalMs = 0,
  fetchImpl,
  className,
}: SchedulerStatusPanelProps) {
  const { t } = useTranslation();
  const [result, setResult] = useState<SchedulerStatusResult | null>(null);
  const [loading, setLoading] = useState(true);

  // Keep the latest fetchImpl in a ref so the polling effect never re-subscribes
  // when a parent passes a fresh function identity each render.
  const fetchImplRef = useRef(fetchImpl);
  fetchImplRef.current = fetchImpl;

  // Monotonic request id. A poll and a manual refresh (or two slow polls) can be
  // in flight at once; without this guard they commit in COMPLETION order, so an
  // older response could overwrite a newer heartbeat. Only the most recently
  // STARTED request is allowed to commit its result.
  const requestIdRef = useRef(0);

  const load = useCallback(async (signal?: AbortSignal) => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    try {
      const next = await fetchSchedulerStatus({ fetchImpl: fetchImplRef.current, signal });
      // Drop a stale response: aborted (unmount/interval change) or superseded by
      // a newer load() that started after this one.
      if (signal?.aborted || requestId !== requestIdRef.current) return;
      setResult(next);
    } finally {
      if (!signal?.aborted && requestId === requestIdRef.current) setLoading(false);
    }
  }, []);

  // Initial load + optional poll. One AbortController per effect run cancels any
  // in-flight request on unmount / interval change.
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);

    let timer: ReturnType<typeof setInterval> | undefined;
    if (pollIntervalMs > 0) {
      timer = setInterval(() => void load(controller.signal), pollIntervalMs);
    }

    return () => {
      controller.abort();
      if (timer) clearInterval(timer);
    };
  }, [load, pollIntervalMs]);

  const view = result ? toSchedulerStatusView(result) : null;
  const tone: SchedulerTone = view?.tone ?? "idle";
  const PillIcon = TONE_ICON[tone];
  const detail = view?.detail;

  return (
    <Card className={className} data-testid="scheduler-status-panel">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <ActivityIcon className="h-4 w-4 text-muted-foreground" />
              {t("evolution.scheduler.title", "Cadence Scheduler")}
            </CardTitle>
            <CardDescription className="mt-1">
              {t(
                "evolution.scheduler.description",
                "Read-only heartbeat of the autonomous evolution loop.",
              )}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {view && (
              <Badge
                variant="outline"
                className={`gap-1 text-[11px] ${TONE_PILL_CLASS[tone]}`}
                data-testid="scheduler-status-pill"
                data-tone={tone}
              >
                <PillIcon className="h-3 w-3" />
                {t(view.labelKey, view.labelDefault)}
              </Badge>
            )}
            <Button
              variant="outline"
              size="icon-sm"
              onClick={() => void load()}
              disabled={loading}
              aria-label={t("common.refresh", "Refresh")}
              data-testid="scheduler-status-refresh"
            >
              {loading ? (
                <Loader2Icon className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCwIcon className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* Error / denial message (non-configured states). */}
        {view?.tone === "error" && view.message && (
          <div className="flex items-center gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
            <AlertTriangleIcon className="size-4 shrink-0" />
            <span>{view.message}</span>
          </div>
        )}
        {view?.tone === "denied" && (
          <div className="flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <XCircleIcon className="size-4 shrink-0" />
            <span>
              {t("evolution.scheduler.deniedHint", "Not authorized to view scheduler status.")}
            </span>
          </div>
        )}
        {view?.tone === "disabled" && (
          <div className="flex items-center gap-2 rounded-md border border-dashed bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            <PowerOffIcon className="size-4 shrink-0" />
            <span>
              {t(
                "evolution.scheduler.disabledHint",
                "Cadence loop is not wired in this environment.",
              )}
            </span>
          </div>
        )}

        {/* Wired-scheduler detail block. */}
        {detail && (
          <div className="space-y-2">
            <DetailRow
              label={t("evolution.scheduler.interval", "Interval")}
              value={humanizeMs(detail.intervalMs)}
            />
            <DetailRow
              label={t("evolution.scheduler.ticks", "Ticks (completed / started)")}
              value={`${detail.ticksCompleted} / ${detail.ticksStarted}`}
            />
            <DetailRow
              label={t("evolution.scheduler.lastTick", "Last tick")}
              value={formatTimestamp(detail.lastTickCompletedAt ?? detail.lastTickStartedAt)}
            />
            <DetailRow
              label={t("evolution.scheduler.lastDuration", "Last duration")}
              value={humanizeMs(detail.lastTickDurationMs)}
            />

            {/* Error-streak warning row. */}
            {hasErrorStreak(detail) ? (
              <div
                className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400"
                data-testid="scheduler-error-streak"
              >
                <AlertTriangleIcon className="size-4 shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <p className="font-medium">
                    {t("evolution.scheduler.errorStreak", "Consecutive errors: {{count}}", {
                      count: detail.consecutiveErrors,
                    })}
                  </p>
                  {detail.lastError && (
                    <p className="mt-0.5 break-words font-mono text-[12px] opacity-90">
                      {detail.lastError}
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <CheckCircle2 className="size-3.5 text-emerald-600 dark:text-emerald-400" />
                {t("evolution.scheduler.healthy", "No recent errors")}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
