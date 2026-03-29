/**
 * MetricsDashboardPage — /admin/metrics
 *
 * System metrics dashboard displaying action stats, rule blocks,
 * active flows, and query performance.
 *
 * Data source audit:
 * - All data: DYNAMIC — fetched from GET /api/metrics which is served by
 *   the MetricsCollector on the server side.
 * - Auto-refreshes every 30 seconds.
 */

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Skeleton,
} from "@linchkit/ui-kit/components";
import {
  ActivityIcon,
  AlertTriangleIcon,
  BarChart2Icon,
  CheckCircleIcon,
  ClockIcon,
  GitBranchIcon,
  InboxIcon,
  RefreshCwIcon,
  ShieldIcon,
  XCircleIcon,
  ZapIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

// ── Types ────────────────────────────────────────────────

interface ActionMetrics {
  name: string;
  count: number;
  errorRate: number;
  durationP50: number;
  durationP95: number;
  durationP99: number;
}

interface MetricsSummary {
  actions: {
    totalCount: number;
    errorRate: number;
    topActions: ActionMetrics[];
  };
  rules: {
    blockCount: number;
    evaluationDurationP50: number;
  };
  queries: {
    count: number;
    durationP50: number;
    durationP95: number;
  };
  flows: {
    activeCount: number;
    completionTimeP50: number;
  };
  events: {
    count: number;
  };
  outbox: {
    pending: number;
    processingDurationP50: number;
  };
  collectedAt: string;
}

// ── Constants ────────────────────────────────────────────

const REFRESH_INTERVAL_MS = 15_000;

// ── Helpers ──────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function getErrorRateVariant(rate: number): "default" | "secondary" | "destructive" | "outline" {
  if (rate > 0.1) return "destructive";
  if (rate > 0.05) return "secondary";
  return "default";
}

// ── Sub-components ───────────────────────────────────────

function StatCard({
  title,
  value,
  sub,
  icon,
  accent,
}: {
  title: string;
  value: string | number;
  sub?: string;
  icon: React.ReactNode;
  accent?: "green" | "amber" | "red" | "blue" | "purple";
}) {
  const accentClass = {
    green: "text-emerald-500",
    amber: "text-amber-500",
    red: "text-red-500",
    blue: "text-blue-500",
    purple: "text-purple-500",
  }[accent ?? "blue"];

  return (
    <Card size="sm">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
            {title}
          </span>
          <span className={accentClass}>{icon}</span>
        </div>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold font-mono">{value}</div>
        {sub && <div className="text-xs text-muted-foreground mt-1">{sub}</div>}
      </CardContent>
    </Card>
  );
}

function ActionRow({ action }: { action: ActionMetrics }) {
  return (
    <div className="flex items-center gap-3 py-2 border-b last:border-0 text-sm">
      <div className="flex-1 min-w-0">
        <div className="font-mono text-xs truncate">{action.name}</div>
      </div>
      <div className="text-xs text-muted-foreground shrink-0">
        {action.count.toLocaleString()} runs
      </div>
      <Badge variant={getErrorRateVariant(action.errorRate)} className="text-[10px] shrink-0">
        {formatRate(action.errorRate)} err
      </Badge>
      <div className="text-xs font-mono text-muted-foreground shrink-0 hidden sm:block">
        p50: {formatDuration(action.durationP50)}
      </div>
      <div className="text-xs font-mono text-muted-foreground shrink-0 hidden lg:block">
        p95: {formatDuration(action.durationP95)}
      </div>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 6 }).map((_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton
          <Card key={i} size="sm">
            <CardHeader className="pb-2">
              <Skeleton className="h-3 w-24" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-8 w-16 mb-1" />
              <Skeleton className="h-3 w-32" />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ── Main component ───────────────────────────────────────

export function MetricsDashboardPage() {
  const { t } = useTranslation();
  const [metrics, setMetrics] = useState<MetricsSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchMetrics = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = localStorage.getItem("linchkit:token");
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;

      const res = await fetch("/api/metrics", { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setMetrics(data as MetricsSummary);
      setLastRefresh(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMetrics();
    intervalRef.current = setInterval(fetchMetrics, REFRESH_INTERVAL_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchMetrics]);

  return (
    <div className="w-full p-4 space-y-6">
      {/* Header row */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <BarChart2Icon className="size-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">{t("metrics.title", "System Metrics")}</h1>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {lastRefresh && (
            <span className="text-xs text-muted-foreground hidden sm:block">
              {t("health.lastRefresh")}: {lastRefresh.toLocaleTimeString()}
            </span>
          )}
          <Button variant="outline" size="sm" onClick={fetchMetrics} disabled={loading}>
            <RefreshCwIcon className={`size-4 mr-1 ${loading ? "animate-spin" : ""}`} />
            {t("executionLog.refresh")}
          </Button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="rounded-lg p-4 bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-400 text-sm flex items-center gap-2">
          <XCircleIcon className="size-4 shrink-0" />
          {t("metrics.fetchError", "Failed to load metrics")}: {error}
        </div>
      )}

      {/* Loading skeleton */}
      {loading && !metrics && <LoadingSkeleton />}

      {/* Summary stat cards */}
      {metrics && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            <StatCard
              title={t("metrics.actionCount", "Action Executions")}
              value={metrics.actions.totalCount.toLocaleString()}
              sub={`${t("metrics.errorRate", "Error rate")}: ${formatRate(metrics.actions.errorRate)}`}
              icon={<ZapIcon className="size-5" />}
              accent={metrics.actions.errorRate > 0.1 ? "red" : metrics.actions.errorRate > 0.05 ? "amber" : "green"}
            />

            <StatCard
              title={t("metrics.ruleBlocks", "Rule Blocks")}
              value={metrics.rules.blockCount.toLocaleString()}
              sub={`${t("metrics.evalLatency", "Eval p50")}: ${formatDuration(metrics.rules.evaluationDurationP50)}`}
              icon={<ShieldIcon className="size-5" />}
              accent="purple"
            />

            <StatCard
              title={t("metrics.activeFlows", "Active Flows")}
              value={metrics.flows.activeCount.toLocaleString()}
              sub={metrics.flows.completionTimeP50 > 0
                ? `${t("metrics.completionP50", "Completion p50")}: ${formatDuration(metrics.flows.completionTimeP50)}`
                : undefined}
              icon={<GitBranchIcon className="size-5" />}
              accent="blue"
            />

            <StatCard
              title={t("metrics.outboxPending", "Outbox Pending")}
              value={metrics.outbox.pending.toLocaleString()}
              sub={metrics.outbox.processingDurationP50 > 0
                ? `${t("metrics.processingP50", "Processing p50")}: ${formatDuration(metrics.outbox.processingDurationP50)}`
                : undefined}
              icon={<InboxIcon className="size-5" />}
              accent={metrics.outbox.pending > 100 ? "amber" : "green"}
            />

            <StatCard
              title={t("metrics.queryCount", "GraphQL Queries")}
              value={metrics.queries.count.toLocaleString()}
              sub={`p50: ${formatDuration(metrics.queries.durationP50)} · p95: ${formatDuration(metrics.queries.durationP95)}`}
              icon={<ActivityIcon className="size-5" />}
              accent="blue"
            />

            <StatCard
              title={t("metrics.eventCount", "Events Emitted")}
              value={metrics.events.count.toLocaleString()}
              icon={<ClockIcon className="size-5" />}
              accent="purple"
            />
          </div>

          {/* Top actions table */}
          {metrics.actions.topActions.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <ZapIcon className="size-4" />
                  {t("metrics.topActions", "Top Actions")}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {metrics.actions.topActions.map((action) => (
                  <ActionRow key={action.name} action={action} />
                ))}
              </CardContent>
            </Card>
          )}

          {/* Action health summary */}
          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <CheckCircleIcon className="size-4 text-emerald-500" />
                  {t("metrics.queryPerformance", "Query Performance")}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <PerfRow label="p50" value={formatDuration(metrics.queries.durationP50)} />
                <PerfRow label="p95" value={formatDuration(metrics.queries.durationP95)} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <AlertTriangleIcon className="size-4 text-amber-500" />
                  {t("metrics.ruleEvalPerformance", "Rule Eval Performance")}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <PerfRow
                  label="p50"
                  value={formatDuration(metrics.rules.evaluationDurationP50)}
                />
                <PerfRow
                  label={t("metrics.blockCount", "Block count")}
                  value={metrics.rules.blockCount.toLocaleString()}
                />
              </CardContent>
            </Card>
          </div>
        </>
      )}

      {/* Empty state when no error and no data */}
      {!loading && !error && !metrics && (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
          <BarChart2Icon className="size-10 opacity-30" />
          <p className="text-sm">{t("metrics.noData", "No metrics available yet")}</p>
        </div>
      )}

      <p className="text-xs text-muted-foreground text-center">
        {t("health.autoRefresh", { seconds: REFRESH_INTERVAL_MS / 1000 })}
      </p>
    </div>
  );
}

// ── Perf row sub-component ───────────────────────────────

function PerfRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono font-medium">{value}</span>
    </div>
  );
}
