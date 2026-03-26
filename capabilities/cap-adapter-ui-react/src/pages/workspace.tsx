import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "@tanstack/react-router";
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Skeleton,
} from "@linchkit/ui-kit/components";
import {
  Activity,
  ArrowRight,
  CheckCircle2,
  Clock,
  Database,
  Plus,
  XCircle,
  AlertTriangle,
  Hourglass,
} from "lucide-react";
import { useSchemas } from "@/hooks/use-schemas";
import {
  graphql,
  queryExecutionLogs,
  type ExecutionLogEntry,
  type SchemaInfo,
} from "@/lib/api";

// ── Schema record counts ────────────────────────────────

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

/**
 * Fetch record counts for all schemas in a single batched GraphQL query.
 * Uses pageSize=1 to minimize payload — we only need the `total` field.
 */
async function fetchSchemaCounts(
  schemas: SchemaInfo[],
): Promise<Record<string, number>> {
  if (schemas.length === 0) return {};

  // Build a batched query: one field per schema
  const fields = schemas
    .map((s) => {
      const alias = toCamelCase(s.name);
      return `${alias}: ${alias}List(pageSize: 1) { total }`;
    })
    .join("\n    ");

  const query = `query { ${fields} }`;

  try {
    const res = await graphql<Record<string, { total: number }>>(query);
    if (res.errors) return {};
    const counts: Record<string, number> = {};
    for (const s of schemas) {
      const alias = toCamelCase(s.name);
      counts[s.name] = res.data?.[alias]?.total ?? 0;
    }
    return counts;
  } catch {
    return {};
  }
}

// ── Status badge helper ─────────────────────────────────

function StatusBadge({ status }: { status: ExecutionLogEntry["status"] }) {
  const { t } = useTranslation();
  switch (status) {
    case "succeeded":
      return (
        <Badge variant="outline" className="gap-1 text-green-600 border-green-200 bg-green-50">
          <CheckCircle2 className="h-3 w-3" />
          {t("executionLog.succeeded")}
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="outline" className="gap-1 text-red-600 border-red-200 bg-red-50">
          <XCircle className="h-3 w-3" />
          {t("executionLog.failed")}
        </Badge>
      );
    case "blocked":
      return (
        <Badge variant="outline" className="gap-1 text-yellow-600 border-yellow-200 bg-yellow-50">
          <AlertTriangle className="h-3 w-3" />
          {t("executionLog.blocked")}
        </Badge>
      );
    case "pending_approval":
      return (
        <Badge variant="outline" className="gap-1 text-blue-600 border-blue-200 bg-blue-50">
          <Hourglass className="h-3 w-3" />
          {t("executionLog.pendingApproval")}
        </Badge>
      );
  }
}

// ── Time formatting ─────────────────────────────────────

function formatRelativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

// ── Schema Stats Cards ──────────────────────────────────

function SchemaStatsCards({
  schemas,
  counts,
  loading,
}: {
  schemas: SchemaInfo[];
  counts: Record<string, number>;
  loading: boolean;
}) {
  const { t } = useTranslation();

  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {[1, 2, 3, 4].map((i) => (
          <Card key={i}>
            <CardHeader className="pb-2">
              <Skeleton className="h-4 w-24" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-8 w-16" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (schemas.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          {t("common.noData")}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {schemas.map((schema) => {
        const label =
          t(`schemas.${schema.name}._label`, { defaultValue: "" }) ||
          schema.label ||
          schema.name;
        const count = counts[schema.name] ?? 0;

        return (
          <Link key={schema.name} to="/schemas/$name" params={{ name: schema.name }}>
            <Card className="transition-colors hover:bg-accent/50 cursor-pointer">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium">{label}</CardTitle>
                <Database className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="flex items-end justify-between">
                  <span className="text-2xl font-bold">{count}</span>
                  <span className="text-xs text-muted-foreground">
                    {t("list.recordCount", { count })}
                  </span>
                </div>
              </CardContent>
            </Card>
          </Link>
        );
      })}
    </div>
  );
}

// ── Quick Actions ───────────────────────────────────────

function QuickActions({ schemas }: { schemas: SchemaInfo[] }) {
  const { t } = useTranslation();

  if (schemas.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {schemas.map((schema) => {
        const label =
          t(`schemas.${schema.name}._label`, { defaultValue: "" }) ||
          schema.label ||
          schema.name;
        return (
          <Link key={schema.name} to="/schemas/$name/new" params={{ name: schema.name }}>
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

function RecentActivity({
  logs,
  loading,
}: {
  logs: ExecutionLogEntry[];
  loading: boolean;
}) {
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
        const schemaLabel = log.schema
          ? t(`schemas.${log.schema}._label`, { defaultValue: "" }) || log.schema
          : "";

        return (
          <div
            key={log.id}
            className="flex items-start gap-3 rounded-md border p-3 text-sm"
          >
            {/* Icon */}
            <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted">
              <Activity className="h-3.5 w-3.5 text-muted-foreground" />
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium">{log.action}</span>
                {schemaLabel && (
                  <Badge variant="outline" className="text-xs">
                    {schemaLabel}
                  </Badge>
                )}
                <StatusBadge status={log.status} />
              </div>

              <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {formatRelativeTime(log.startedAt)}
                </span>
                {log.actor?.id && (
                  <span>
                    {t("executionLog.actor")}: {log.actor.id}
                  </span>
                )}
                {log.duration > 0 && (
                  <span>
                    {log.duration}ms
                  </span>
                )}
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

/** Workspace page — data-driven dashboard with schema stats and recent activity */
export function WorkspacePage() {
  const { t } = useTranslation();
  const { schemas, loading: schemasLoading } = useSchemas();

  const [counts, setCounts] = useState<Record<string, number>>({});
  const [countsLoading, setCountsLoading] = useState(true);

  const [logs, setLogs] = useState<ExecutionLogEntry[]>([]);
  const [logsLoading, setLogsLoading] = useState(true);

  // Fetch schema counts when schemas are available
  useEffect(() => {
    if (schemasLoading) return;
    setCountsLoading(true);
    fetchSchemaCounts(schemas).then((c) => {
      setCounts(c);
      setCountsLoading(false);
    });
  }, [schemas, schemasLoading]);

  // Fetch recent execution logs
  useEffect(() => {
    setLogsLoading(true);
    queryExecutionLogs({ pageSize: 10 })
      .then((result) => setLogs(result.items))
      .catch(() => setLogs([]))
      .finally(() => setLogsLoading(false));
  }, []);

  return (
    <div className="space-y-6 p-4">
      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold text-foreground">
          {t("workspace.title")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("workspace.subtitle")}
        </p>
      </div>

      {/* Schema stats */}
      <section>
        <h2 className="mb-3 text-sm font-medium text-muted-foreground">
          {t("workspace.dataOverview")}
        </h2>
        <SchemaStatsCards
          schemas={schemas}
          counts={counts}
          loading={schemasLoading || countsLoading}
        />
      </section>

      {/* Quick actions */}
      {schemas.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-medium text-muted-foreground">
            {t("workspace.quickActionsLabel")}
          </h2>
          <QuickActions schemas={schemas} />
        </section>
      )}

      {/* Recent activity */}
      <section>
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-sm">
                  {t("workspace.recentActivity")}
                </CardTitle>
                <CardDescription className="text-xs">
                  {t("workspace.recentActivityDesc")}
                </CardDescription>
              </div>
              <Link
                to="/admin/executions"
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
