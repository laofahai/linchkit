import type { StateDefinition, StateMeta } from "@linchkit/core/types";
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Skeleton,
} from "@linchkit/ui-kit/components";
import { Link } from "@tanstack/react-router";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock,
  Database,
  Hourglass,
  Plus,
  TrendingUp,
  XCircle,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AIInsightsPanel } from "@/components/ai-insights-panel";
import { useEntities } from "@/hooks/use-entities";
import { useEntityLabel } from "@/i18n/use-entity-label";
import {
  type EntityInfo,
  type ExecutionLogEntry,
  fetchEntityBundle,
  graphql,
  queryExecutionLogs,
} from "@/lib/api";
import { getLucideIcon } from "@/lib/dynamic-icon";
import { getStateBadgeClass } from "@/lib/state-colors";

// ── Types ────────────────────────────────────────────────

/** State breakdown: count per state value */
type StateBreakdown = Record<string, number>;

/** Aggregated summary data for a schema */
interface EntitySummary {
  total: number;
  stateBreakdown: StateBreakdown;
  recentCount: number;
  stateFieldName?: string;
  stateMeta?: Partial<Record<string, StateMeta>>;
}

// ── Helpers ──────────────────────────────────────────────

/** Convert snake_case to camelCase for GraphQL query names */
function toCamelCase(name: string): string {
  const parts = name.split(/[_-]/);
  return (
    parts[0] +
    parts
      .slice(1)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join("")
  );
}

// ── Data fetching ────────────────────────────────────────

/**
 * Fetch record counts + state breakdown for all entities.
 * Uses batched GraphQL queries to minimize round-trips.
 */
async function fetchEntitySummaries(
  entities: EntityInfo[],
  logs: ExecutionLogEntry[],
): Promise<Record<string, EntitySummary>> {
  if (entities.length === 0) return {};

  // Step 1: Detect which entities have state fields by fetching bundles
  const stateFields = new Map<string, { fieldName: string; states?: StateDefinition[] }>();
  const bundlePromises = entities.map(async (s) => {
    try {
      const bundle = await fetchEntityBundle(s.name);
      if (!bundle) return;
      const fields = bundle.fields as Record<string, { type?: string; machine?: string }>;
      for (const [fieldName, fieldDef] of Object.entries(fields)) {
        if (fieldDef.type === "state") {
          stateFields.set(s.name, { fieldName, states: bundle.states });
          break;
        }
      }
    } catch {
      // Ignore — entity will have no state breakdown
    }
  });
  await Promise.all(bundlePromises);

  // Step 2: Batched query for totals (all entities) + state values (entities with state fields)
  const queryParts: string[] = [];
  for (const s of entities) {
    const alias = toCamelCase(s.name);
    const _stateInfo = stateFields.get(s.name);
    // Only fetch total count — state breakdown should be a server-side
    // aggregation, not a client-side full-table scan (pageSize=0 was fetching ALL records).
    queryParts.push(`${alias}: ${alias}List(pageSize: 1) { total }`);
  }

  const query = `query { ${queryParts.join("\n    ")} }`;

  // Step 3: Count recent activity per entity from execution logs (last 24h)
  const recentCounts: Record<string, number> = {};
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const log of logs) {
    if (!log.entity) continue;
    const logTime = new Date(log.startedAt).getTime();
    if (logTime >= cutoff) {
      recentCounts[log.entity] = (recentCounts[log.entity] ?? 0) + 1;
    }
  }

  // Step 4: Execute query and build summaries
  const summaries: Record<string, EntitySummary> = {};
  try {
    const res =
      await graphql<Record<string, { total: number; items?: Record<string, string>[] }>>(query);
    if (res.errors) {
      // Fallback: return empty summaries
      for (const s of entities) {
        summaries[s.name] = {
          total: 0,
          stateBreakdown: {},
          recentCount: recentCounts[s.name] ?? 0,
        };
      }
      return summaries;
    }

    for (const s of entities) {
      const alias = toCamelCase(s.name);
      const data = res.data?.[alias];
      const total = data?.total ?? 0;
      const stateInfo = stateFields.get(s.name);

      // State breakdown requires server-side aggregation (not yet implemented).
      // For now, only total count is available.
      const stateBreakdown: StateBreakdown = {};

      // Extract state meta for color resolution
      let stateMeta: Partial<Record<string, StateMeta>> | undefined;
      if (stateInfo?.states?.[0]?.meta) {
        stateMeta = stateInfo.states[0].meta;
      }

      summaries[s.name] = {
        total,
        stateBreakdown,
        recentCount: recentCounts[s.name] ?? 0,
        stateFieldName: stateInfo?.fieldName,
        stateMeta,
      };
    }
  } catch {
    for (const s of entities) {
      summaries[s.name] = { total: 0, stateBreakdown: {}, recentCount: recentCounts[s.name] ?? 0 };
    }
  }

  return summaries;
}

// ── Status badge helper ─────────────────────────────────

function StatusBadge({ status }: { status: ExecutionLogEntry["status"] }) {
  const { t } = useTranslation();
  switch (status) {
    case "succeeded":
      return (
        <Badge
          variant="outline"
          className="gap-1 text-green-600 dark:text-green-400 border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950"
        >
          <CheckCircle2 className="h-3 w-3" />
          {t("executionLog.succeeded")}
        </Badge>
      );
    case "failed":
      return (
        <Badge
          variant="outline"
          className="gap-1 text-red-600 dark:text-red-400 border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950"
        >
          <XCircle className="h-3 w-3" />
          {t("executionLog.failed")}
        </Badge>
      );
    case "blocked":
      return (
        <Badge
          variant="outline"
          className="gap-1 text-yellow-600 dark:text-yellow-400 border-yellow-200 dark:border-yellow-800 bg-yellow-50 dark:bg-yellow-950"
        >
          <AlertTriangle className="h-3 w-3" />
          {t("executionLog.blocked")}
        </Badge>
      );
    case "pending_approval":
      return (
        <Badge
          variant="outline"
          className="gap-1 text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950"
        >
          <Hourglass className="h-3 w-3" />
          {t("executionLog.pendingApproval")}
        </Badge>
      );
  }
}

// ── Time formatting ─────────────────────────────────────

function formatRelativeTime(
  dateStr: string,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return t("time.justNow", { defaultValue: "just now" });
  if (diffMin < 60) return t("time.minutesAgo", { defaultValue: "{{count}}m ago", count: diffMin });
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return t("time.hoursAgo", { defaultValue: "{{count}}h ago", count: diffHr });
  const diffDay = Math.floor(diffHr / 24);
  return t("time.daysAgo", { defaultValue: "{{count}}d ago", count: diffDay });
}

// ── State Breakdown Badges ──────────────────────────────

function StateBreakdownBadges({
  breakdown,
  stateMeta,
}: {
  breakdown: StateBreakdown;
  stateMeta?: Partial<Record<string, StateMeta>>;
}) {
  const { t } = useTranslation();
  const entries = Object.entries(breakdown);
  if (entries.length === 0) return null;

  // Sort by count descending, show top 3
  const sorted = entries.sort((a, b) => b[1] - a[1]).slice(0, 3);
  const remaining = entries.length - sorted.length;

  return (
    <div className="flex flex-wrap gap-1 mt-2">
      {sorted.map(([state, count]) => {
        const colorClass = getStateBadgeClass(stateMeta?.[state]?.color);
        const rawLabel = stateMeta?.[state]?.label;
        let stateLabel: string;
        if (rawLabel?.startsWith("t:")) {
          stateLabel = t(rawLabel.slice(2), { defaultValue: state });
        } else {
          stateLabel = rawLabel ?? t(`states.${state}`, { defaultValue: state });
        }
        return (
          <span
            key={state}
            className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium ${colorClass}`}
          >
            {count} {stateLabel}
          </span>
        );
      })}
      {remaining > 0 && (
        <span className="inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground bg-muted">
          +{remaining}
        </span>
      )}
    </div>
  );
}

// ── Entity Summary Cards ─────────────────────────────────

function EntitySummaryCards({
  entities,
  summaries,
  loading,
}: {
  entities: EntityInfo[];
  summaries: Record<string, EntitySummary>;
  loading: boolean;
}) {
  const { t } = useTranslation();
  const { resolveLabel } = useEntityLabel();

  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[1, 2, 3].map((i) => (
          <Card key={i}>
            <CardHeader className="pb-2">
              <Skeleton className="h-4 w-24" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-8 w-16 mb-2" />
              <div className="flex gap-1">
                <Skeleton className="h-4 w-16" />
                <Skeleton className="h-4 w-16" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (entities.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          {t("common.noData")}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {entities.map((schema) => {
        const label = resolveLabel(schema.label, schema.name);
        const summary = summaries[schema.name];
        const total = summary?.total ?? 0;
        const recentCount = summary?.recentCount ?? 0;
        const stateBreakdown = summary?.stateBreakdown ?? {};
        const hasStates = Object.keys(stateBreakdown).length > 0;

        // Resolve entity icon
        const EntityIcon = getLucideIcon(schema.icon) ?? Database;

        return (
          <Link key={schema.name} to="/entities/$name" params={{ name: schema.name }}>
            <Card className="transition-colors hover:bg-accent/50 cursor-pointer h-full">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <div className="flex items-center gap-2">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                    <EntityIcon className="h-4 w-4 text-primary" />
                  </div>
                  <CardTitle className="text-sm font-medium">{label}</CardTitle>
                </div>
                {recentCount > 0 && (
                  <span
                    className="flex items-center gap-1 text-[10px] text-muted-foreground"
                    title={t("workspace.recentActivityCount", {
                      defaultValue: "{{count}} actions in last 24h",
                      count: recentCount,
                    })}
                  >
                    <TrendingUp className="h-3 w-3" />
                    {recentCount}
                  </span>
                )}
              </CardHeader>
              <CardContent>
                <div className="flex items-end justify-between">
                  <span className="text-2xl font-bold">{total}</span>
                  <span className="text-xs text-muted-foreground">
                    {t("list.recordCount", { count: total })}
                  </span>
                </div>
                {hasStates && (
                  <StateBreakdownBadges breakdown={stateBreakdown} stateMeta={summary?.stateMeta} />
                )}
              </CardContent>
            </Card>
          </Link>
        );
      })}
    </div>
  );
}

// ── Quick Actions ───────────────────────────────────────

function QuickActions({ entities }: { entities: EntityInfo[] }) {
  const { t } = useTranslation();
  const { resolveLabel } = useEntityLabel();

  if (entities.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {entities.map((schema) => {
        const label = resolveLabel(schema.label, schema.name);
        return (
          <Link key={schema.name} to="/entities/$name/new" params={{ name: schema.name }}>
            <Badge
              variant="secondary"
              className="cursor-pointer gap-1 px-3 py-1.5 text-sm transition-colors hover:bg-accent"
            >
              <Plus className="h-3 w-3" />
              {t("common.create")} {label}
            </Badge>
          </Link>
        );
      })}
    </div>
  );
}

// ── Recent Activity ─────────────────────────────────────

function RecentActivity({ logs, loading }: { logs: ExecutionLogEntry[]; loading: boolean }) {
  const { t } = useTranslation();

  if (loading) {
    return (
      <div className="space-y-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="flex items-start gap-3">
            <Skeleton className="h-8 w-8 rounded-full" />
            <div className="flex-1 space-y-1">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-3 w-32" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (logs.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        {t("executionLog.noEntries")}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {logs.map((log) => {
        const entityLabel = log.entity
          ? t(`entities.${log.entity}._label`, { defaultValue: "" }) || log.entity
          : "";

        return (
          <div key={log.id} className="flex items-start gap-3 rounded-md border p-3 text-sm">
            {/* Icon */}
            <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted">
              <Activity className="h-3.5 w-3.5 text-muted-foreground" />
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium">{log.action}</span>
                {entityLabel && (
                  <Badge variant="outline" className="text-xs">
                    {entityLabel}
                  </Badge>
                )}
                <StatusBadge status={log.status} />
              </div>

              <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {formatRelativeTime(log.startedAt, t)}
                </span>
                {log.actor?.id && (
                  <span>
                    {t("executionLog.actor")}: {log.actor.id}
                  </span>
                )}
                {log.duration > 0 && <span>{log.duration}ms</span>}
                {log.stateTransition && (
                  <span>
                    {log.stateTransition.from} → {log.stateTransition.to}
                  </span>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Workspace Page ──────────────────────────────────────

/** Workspace page — data-driven dashboard with entity stats and recent activity */
export function WorkspacePage() {
  const { t } = useTranslation();
  const { entities, loading: entitiesLoading } = useEntities();

  const [summaries, setSummaries] = useState<Record<string, EntitySummary>>({});
  const [summariesLoading, setSummariesLoading] = useState(true);

  const [logs, setLogs] = useState<ExecutionLogEntry[]>([]);
  const [logsLoading, setLogsLoading] = useState(true);

  // Track whether summaries have been fetched to avoid re-fetching
  const summariesFetchedRef = useRef(false);

  // Fetch recent execution logs
  useEffect(() => {
    setLogsLoading(true);
    queryExecutionLogs({ pageSize: 10 })
      .then((result) => setLogs(result.items))
      .catch(() => setLogs([]))
      .finally(() => setLogsLoading(false));
  }, []);

  // Fetch entity summaries (counts + state breakdown + recent activity)
  // Depends on both entities and logs being ready
  useEffect(() => {
    if (entitiesLoading || logsLoading) return;
    if (summariesFetchedRef.current) return;
    summariesFetchedRef.current = true;

    setSummariesLoading(true);
    fetchEntitySummaries(entities, logs)
      .then(setSummaries)
      .finally(() => setSummariesLoading(false));
  }, [entities, entitiesLoading, logs, logsLoading]);

  return (
    <div className="space-y-6 p-4">
      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold text-foreground">{t("workspace.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("workspace.subtitle")}</p>
      </div>

      {/* Entity summary cards */}
      <section>
        <h2 className="mb-3 text-sm font-medium text-muted-foreground">
          {t("workspace.dataOverview")}
        </h2>
        <EntitySummaryCards
          entities={entities}
          summaries={summaries}
          loading={entitiesLoading || summariesLoading}
        />
      </section>

      {/* Quick actions */}
      {entities.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-medium text-muted-foreground">
            {t("workspace.quickActionsLabel")}
          </h2>
          <QuickActions entities={entities} />
        </section>
      )}

      {/* AI Insights */}
      <section>
        <AIInsightsPanel />
      </section>

      {/* Recent activity */}
      <section>
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-sm">{t("workspace.recentActivity")}</CardTitle>
                <CardDescription className="text-xs">
                  {t("workspace.recentActivityDesc")}
                </CardDescription>
              </div>
              <Link
                to={"/entities/execution_log" as "/"}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                {t("workspace.viewAll")}
                <ArrowRight className="h-3 w-3" />
              </Link>
            </div>
          </CardHeader>
          <CardContent>
            <RecentActivity logs={logs} loading={logsLoading} />
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
