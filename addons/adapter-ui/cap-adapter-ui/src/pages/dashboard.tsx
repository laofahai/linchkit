import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from "@linchkit/ui-kit/components";
import { Link } from "@tanstack/react-router";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Clock,
  Database,
  Edit3,
  Hourglass,
  LineChart,
  Maximize2,
  PieChart,
  Plus,
  Trash2,
  TrendingUp,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReactGridLayout as GridLayout } from "react-grid-layout/legacy";
import { useTranslation } from "react-i18next";
import {
  Bar,
  BarChart,
  Cell,
  Line,
  Pie,
  LineChart as RechartsLineChart,
  PieChart as RechartsPieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useEntities } from "@/hooks/use-entities";
import { useSchemaLabel } from "@/i18n/use-entity-label";
import { type ExecutionLogEntry, graphql, queryExecutionLogs, type SchemaInfo } from "@/lib/api";
import { getLucideIcon } from "@/lib/dynamic-icon";

// CSS for react-grid-layout drag/resize handles

// ── Types ─────────────────────────────────────────────────────────────────────

type DashboardWidgetType =
  | "stat_card"
  | "chart"
  | "recent_activity"
  | "record_list"
  | "quick_actions";

type ChartType = "bar" | "line" | "pie";

interface WidgetConfig {
  schema?: string;
  chartType?: ChartType;
  label?: string;
  timeRange?: "1h" | "24h" | "7d" | "30d";
  metric?: "count" | "recent";
}

interface DashboardWidget {
  id: string;
  type: DashboardWidgetType;
  config: WidgetConfig;
}

interface GridItem {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
}

interface DashboardLayout {
  widgets: DashboardWidget[];
  grid: GridItem[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

const STORAGE_KEY = "linchkit:dashboard:layout";
const GRID_COLS = 12;
const ROW_HEIGHT = 80;

const CHART_COLORS = ["#6366f1", "#8b5cf6", "#a78bfa", "#c4b5fd", "#ddd6fe"];

// ── Default layout ────────────────────────────────────────────────────────────

function createDefaultLayout(): DashboardLayout {
  return {
    widgets: [
      { id: "w1", type: "stat_card", config: { label: "Total Records", metric: "count" } },
      { id: "w2", type: "recent_activity", config: {} },
      { id: "w3", type: "quick_actions", config: {} },
      { id: "w4", type: "chart", config: { chartType: "bar", label: "Activity Overview" } },
    ],
    grid: [
      { i: "w1", x: 0, y: 0, w: 4, h: 2, minW: 3, minH: 2 },
      { i: "w2", x: 4, y: 0, w: 8, h: 4, minW: 4, minH: 3 },
      { i: "w3", x: 0, y: 2, w: 4, h: 2, minW: 3, minH: 2 },
      { i: "w4", x: 0, y: 4, w: 12, h: 4, minW: 6, minH: 3 },
    ],
  };
}

// ── Persistence ───────────────────────────────────────────────────────────────

function loadLayout(): DashboardLayout {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return JSON.parse(stored) as DashboardLayout;
  } catch {
    // Ignore parse errors
  }
  return createDefaultLayout();
}

function saveLayout(layout: DashboardLayout): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // Ignore storage errors
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// ── Status Badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: ExecutionLogEntry["status"] }) {
  switch (status) {
    case "succeeded":
      return (
        <Badge
          variant="outline"
          className="gap-1 text-green-600 border-green-200 bg-green-50 dark:text-green-400 dark:border-green-800 dark:bg-green-950"
        >
          <CheckCircle2 className="h-3 w-3" />
          OK
        </Badge>
      );
    case "failed":
      return (
        <Badge
          variant="outline"
          className="gap-1 text-red-600 border-red-200 bg-red-50 dark:text-red-400 dark:border-red-800 dark:bg-red-950"
        >
          <XCircle className="h-3 w-3" />
          Failed
        </Badge>
      );
    case "blocked":
      return (
        <Badge
          variant="outline"
          className="gap-1 text-yellow-600 border-yellow-200 bg-yellow-50 dark:text-yellow-400 dark:border-yellow-800 dark:bg-yellow-950"
        >
          <AlertTriangle className="h-3 w-3" />
          Blocked
        </Badge>
      );
    case "pending_approval":
      return (
        <Badge
          variant="outline"
          className="gap-1 text-blue-600 border-blue-200 bg-blue-50 dark:text-blue-400 dark:border-blue-800 dark:bg-blue-950"
        >
          <Hourglass className="h-3 w-3" />
          Pending
        </Badge>
      );
  }
}

// ── Widget: Stat Card ─────────────────────────────────────────────────────────

function StatCardWidget({
  config,
  schemas,
  logs,
}: {
  config: WidgetConfig;
  schemas: SchemaInfo[];
  logs: ExecutionLogEntry[];
}) {
  const { resolveLabel } = useSchemaLabel();
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (config.schema) {
      const alias = toCamelCase(config.schema);
      const query = `query { ${alias}: ${alias}List(pageSize: 1) { total } }`;
      graphql<Record<string, { total: number }>>(query)
        .then((res) => {
          setTotal(res.data?.[alias]?.total ?? 0);
        })
        .catch(() => setTotal(0))
        .finally(() => setLoading(false));
    } else {
      // Total across all schemas
      if (schemas.length === 0) {
        setLoading(false);
        setTotal(0);
        return;
      }
      const queryParts = schemas.map((s) => {
        const alias = toCamelCase(s.name);
        return `${alias}: ${alias}List(pageSize: 1) { total }`;
      });
      const query = `query { ${queryParts.join(" ")} }`;
      graphql<Record<string, { total: number }>>(query)
        .then((res) => {
          if (!res.data) {
            setTotal(0);
            return;
          }
          const sum = Object.values(res.data).reduce((acc, v) => acc + (v?.total ?? 0), 0);
          setTotal(sum);
        })
        .catch(() => setTotal(0))
        .finally(() => setLoading(false));
    }
  }, [config.schema, schemas]);

  // Recent count from logs
  const recentCount = useMemo(() => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return logs.filter((l) => {
      if (config.schema && l.entity !== config.schema) return false;
      return new Date(l.startedAt).getTime() >= cutoff;
    }).length;
  }, [logs, config.schema]);

  const label = config.schema
    ? resolveLabel(schemas.find((s) => s.name === config.schema)?.label, config.schema)
    : (config.label ?? "Total Records");

  const Icon = config.schema
    ? (getLucideIcon(schemas.find((s) => s.name === config.schema)?.icon) ?? Database)
    : Database;

  return (
    <div className="flex flex-col h-full justify-between p-1">
      <div className="flex items-center gap-2">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
          <Icon className="h-4 w-4 text-primary" />
        </div>
        <span className="text-sm font-medium text-muted-foreground truncate">{label}</span>
      </div>
      <div className="mt-2">
        {loading ? (
          <Skeleton className="h-10 w-20" />
        ) : (
          <span className="text-3xl font-bold">{total ?? 0}</span>
        )}
        {recentCount > 0 && (
          <div className="flex items-center gap-1 mt-1 text-xs text-muted-foreground">
            <TrendingUp className="h-3 w-3" />
            {recentCount} in 24h
          </div>
        )}
      </div>
    </div>
  );
}

// ── Widget: Chart ─────────────────────────────────────────────────────────────

function ChartWidget({ config, logs }: { config: WidgetConfig; logs: ExecutionLogEntry[] }) {
  const chartData = useMemo(() => {
    // Group execution logs by schema for bar/line charts
    const counts: Record<string, number> = {};
    for (const log of logs) {
      const key = log.entity ?? "other";
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, value]) => ({ name, value }));
  }, [logs]);

  const pieData = useMemo(() => {
    // For pie chart, group by status
    const counts: Record<string, number> = {};
    for (const log of logs) {
      counts[log.status] = (counts[log.status] ?? 0) + 1;
    }
    return Object.entries(counts).map(([name, value]) => ({ name, value }));
  }, [logs]);

  const chartType = config.chartType ?? "bar";

  if (chartData.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No activity data
      </div>
    );
  }

  return (
    <div className="h-full w-full">
      <p className="text-xs font-medium text-muted-foreground mb-1">
        {config.label ?? "Activity Overview"}
      </p>
      <ResponsiveContainer width="100%" height="85%">
        {chartType === "pie" ? (
          <RechartsPieChart>
            <Pie
              data={pieData}
              dataKey="value"
              nameKey="name"
              cx="50%"
              cy="50%"
              outerRadius="70%"
              label={({ name, percent }) => `${name} ${Math.round((percent ?? 0) * 100)}%`}
            >
              {pieData.map((entry) => (
                <Cell
                  key={`cell-${entry.name}`}
                  fill={CHART_COLORS[pieData.indexOf(entry) % CHART_COLORS.length]}
                />
              ))}
            </Pie>
            <Tooltip />
          </RechartsPieChart>
        ) : chartType === "line" ? (
          <RechartsLineChart data={chartData}>
            <XAxis dataKey="name" tick={{ fontSize: 10 }} />
            <YAxis tick={{ fontSize: 10 }} />
            <Tooltip />
            <Line type="monotone" dataKey="value" stroke="#6366f1" strokeWidth={2} dot={false} />
          </RechartsLineChart>
        ) : (
          <BarChart data={chartData}>
            <XAxis dataKey="name" tick={{ fontSize: 10 }} />
            <YAxis tick={{ fontSize: 10 }} />
            <Tooltip />
            <Bar dataKey="value" fill="#6366f1" radius={[4, 4, 0, 0]} />
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

// ── Widget: Recent Activity ───────────────────────────────────────────────────

function RecentActivityWidget({ logs, loading }: { logs: ExecutionLogEntry[]; loading: boolean }) {
  if (loading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="flex gap-2">
            <Skeleton className="h-6 w-6 rounded-full shrink-0" />
            <Skeleton className="h-6 flex-1" />
          </div>
        ))}
      </div>
    );
  }

  if (logs.length === 0) {
    return <p className="text-center text-xs text-muted-foreground py-4">No recent activity</p>;
  }

  return (
    <div className="space-y-2 overflow-auto h-full">
      {logs.slice(0, 8).map((log) => (
        <div key={log.id} className="flex items-center gap-2 text-xs rounded border p-1.5">
          <Activity className="h-3 w-3 text-muted-foreground shrink-0" />
          <span className="font-medium truncate flex-1">{log.action}</span>
          {log.entity && (
            <Badge variant="outline" className="text-[10px] px-1 py-0 shrink-0">
              {log.entity}
            </Badge>
          )}
          <StatusBadge status={log.status} />
          <span className="text-muted-foreground shrink-0 flex items-center gap-0.5">
            <Clock className="h-2.5 w-2.5" />
            {formatRelativeTime(log.startedAt)}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Widget: Record List ───────────────────────────────────────────────────────

function RecordListWidget({ config, schemas }: { config: WidgetConfig; schemas: SchemaInfo[] }) {
  const { resolveLabel } = useSchemaLabel();
  const [records, setRecords] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(true);
  const schema = config.schema;

  useEffect(() => {
    if (!schema) {
      setLoading(false);
      return;
    }
    const alias = toCamelCase(schema);
    const query = `query { ${alias}: ${alias}List(pageSize: 5) { items { id } total } }`;
    graphql<Record<string, { items: Record<string, unknown>[]; total: number }>>(query)
      .then((res) => {
        setRecords(res.data?.[alias]?.items ?? []);
      })
      .catch(() => setRecords([]))
      .finally(() => setLoading(false));
  }, [schema]);

  if (!schema) {
    return (
      <p className="text-center text-xs text-muted-foreground py-4">
        Configure a schema in widget settings
      </p>
    );
  }

  const schemaInfo = schemas.find((s) => s.name === schema);
  const label = resolveLabel(schemaInfo?.label, schema);
  const Icon = getLucideIcon(schemaInfo?.icon) ?? Database;

  return (
    <div className="h-full flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs font-medium">
          <Icon className="h-3.5 w-3.5 text-primary" />
          {label}
        </div>
        <Link
          to="/schemas/$name"
          params={{ name: schema }}
          className="text-[10px] text-muted-foreground hover:text-foreground"
        >
          View all →
        </Link>
      </div>
      {loading ? (
        <div className="space-y-1.5">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-6 w-full" />
          ))}
        </div>
      ) : records.length === 0 ? (
        <p className="text-center text-xs text-muted-foreground py-2">No records</p>
      ) : (
        <div className="space-y-1 overflow-auto">
          {records.map((rec) => (
            <Link
              key={String(rec.id)}
              to="/schemas/$name/$id"
              params={{ name: schema, id: String(rec.id) }}
              className="block text-xs p-1.5 rounded hover:bg-accent/50 transition-colors border"
            >
              #{String(rec.id).slice(0, 8)}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Widget: Quick Actions ─────────────────────────────────────────────────────

function QuickActionsWidget({ schemas }: { schemas: SchemaInfo[] }) {
  const { resolveLabel } = useSchemaLabel();

  if (schemas.length === 0) {
    return <p className="text-center text-xs text-muted-foreground py-4">No schemas available</p>;
  }

  return (
    <div className="flex flex-wrap gap-2 content-start h-full overflow-auto">
      {schemas.map((schema) => {
        const label = resolveLabel(schema.label, schema.name);
        const Icon = getLucideIcon(schema.icon) ?? Database;
        return (
          <Link key={schema.name} to="/schemas/$name/new" params={{ name: schema.name }}>
            <Badge
              variant="secondary"
              className="cursor-pointer gap-1 px-3 py-1.5 text-sm transition-colors hover:bg-accent"
            >
              <Plus className="h-3 w-3" />
              <Icon className="h-3 w-3" />
              {label}
            </Badge>
          </Link>
        );
      })}
    </div>
  );
}

// ── Widget Renderer ───────────────────────────────────────────────────────────

function WidgetRenderer({
  widget,
  schemas,
  logs,
  logsLoading,
}: {
  widget: DashboardWidget;
  schemas: SchemaInfo[];
  logs: ExecutionLogEntry[];
  logsLoading: boolean;
}) {
  switch (widget.type) {
    case "stat_card":
      return <StatCardWidget config={widget.config} schemas={schemas} logs={logs} />;
    case "chart":
      return <ChartWidget config={widget.config} logs={logs} />;
    case "recent_activity":
      return <RecentActivityWidget logs={logs} loading={logsLoading} />;
    case "record_list":
      return <RecordListWidget config={widget.config} schemas={schemas} />;
    case "quick_actions":
      return <QuickActionsWidget schemas={schemas} />;
  }
}

// ── Widget Type Labels ────────────────────────────────────────────────────────

const WIDGET_TYPE_LABELS: Record<DashboardWidgetType, { label: string; icon: React.ReactNode }> = {
  stat_card: { label: "Stat Card", icon: <TrendingUp className="h-4 w-4" /> },
  chart: { label: "Chart", icon: <BarChart3 className="h-4 w-4" /> },
  recent_activity: { label: "Recent Activity", icon: <Activity className="h-4 w-4" /> },
  record_list: { label: "Record List", icon: <Database className="h-4 w-4" /> },
  quick_actions: { label: "Quick Actions", icon: <Plus className="h-4 w-4" /> },
};

// ── Add Widget Panel ──────────────────────────────────────────────────────────

function AddWidgetPanel({
  open,
  onClose,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  onAdd: (type: DashboardWidgetType) => void;
}) {
  if (!open) return null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Widget</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3 py-4">
          {(
            Object.entries(WIDGET_TYPE_LABELS) as [
              DashboardWidgetType,
              (typeof WIDGET_TYPE_LABELS)[DashboardWidgetType],
            ][]
          ).map(([type, meta]) => (
            <button
              key={type}
              type="button"
              className="flex flex-col items-center gap-2 p-4 rounded-lg border border-border hover:bg-accent/50 transition-colors cursor-pointer text-sm font-medium"
              onClick={() => {
                onAdd(type);
                onClose();
              }}
            >
              {meta.icon}
              {meta.label}
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Widget Config Modal ───────────────────────────────────────────────────────

function WidgetConfigModal({
  widget,
  schemas,
  onSave,
  onClose,
}: {
  widget: DashboardWidget | null;
  schemas: SchemaInfo[];
  onSave: (config: WidgetConfig) => void;
  onClose: () => void;
}) {
  const { resolveLabel } = useSchemaLabel();
  const [config, setConfig] = useState<WidgetConfig>(widget?.config ?? {});

  useEffect(() => {
    if (widget) setConfig(widget.config);
  }, [widget]);

  if (!widget) return null;

  return (
    <Dialog open={!!widget} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Configure {WIDGET_TYPE_LABELS[widget.type]?.label ?? widget.type}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Label */}
          <div className="space-y-1.5">
            <Label htmlFor="widget-label">Label</Label>
            <Input
              id="widget-label"
              value={config.label ?? ""}
              onChange={(e) => setConfig((c) => ({ ...c, label: e.target.value }))}
              placeholder="Widget title"
            />
          </div>

          {/* Schema selector (for stat_card, record_list) */}
          {(widget.type === "stat_card" || widget.type === "record_list") && (
            <div className="space-y-1.5">
              <Label>Schema</Label>
              <Select
                value={config.schema ?? "__all__"}
                onValueChange={(v) =>
                  setConfig((c) => ({ ...c, schema: v === "__all__" ? undefined : v }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="All schemas" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">All schemas</SelectItem>
                  {schemas.map((s) => (
                    <SelectItem key={s.name} value={s.name}>
                      {resolveLabel(s.label, s.name)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Chart type (for chart widget) */}
          {widget.type === "chart" && (
            <div className="space-y-1.5">
              <Label>Chart Type</Label>
              <Select
                value={config.chartType ?? "bar"}
                onValueChange={(v) => setConfig((c) => ({ ...c, chartType: v as ChartType }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="bar">
                    <span className="flex items-center gap-2">
                      <BarChart3 className="h-3.5 w-3.5" /> Bar Chart
                    </span>
                  </SelectItem>
                  <SelectItem value="line">
                    <span className="flex items-center gap-2">
                      <LineChart className="h-3.5 w-3.5" /> Line Chart
                    </span>
                  </SelectItem>
                  <SelectItem value="pie">
                    <span className="flex items-center gap-2">
                      <PieChart className="h-3.5 w-3.5" /> Pie Chart
                    </span>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Time range */}
          {(widget.type === "stat_card" || widget.type === "chart") && (
            <div className="space-y-1.5">
              <Label>Time Range</Label>
              <Select
                value={config.timeRange ?? "24h"}
                onValueChange={(v) =>
                  setConfig((c) => ({ ...c, timeRange: v as WidgetConfig["timeRange"] }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1h">Last 1 hour</SelectItem>
                  <SelectItem value="24h">Last 24 hours</SelectItem>
                  <SelectItem value="7d">Last 7 days</SelectItem>
                  <SelectItem value="30d">Last 30 days</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => onSave(config)}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Dashboard Widget Card ─────────────────────────────────────────────────────

function DashboardWidgetCard({
  widget,
  editMode,
  schemas,
  logs,
  logsLoading,
  onConfigure,
  onRemove,
}: {
  widget: DashboardWidget;
  editMode: boolean;
  schemas: SchemaInfo[];
  logs: ExecutionLogEntry[];
  logsLoading: boolean;
  onConfigure: () => void;
  onRemove: () => void;
}) {
  const meta = WIDGET_TYPE_LABELS[widget.type];

  return (
    <Card className="h-full overflow-hidden flex flex-col">
      <CardHeader className="flex flex-row items-center justify-between py-2 px-3 pb-1 shrink-0">
        <CardTitle className="text-xs font-medium flex items-center gap-1.5 text-muted-foreground">
          {meta?.icon}
          {widget.config.label ?? meta?.label ?? widget.type}
        </CardTitle>
        {editMode && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="p-1 rounded hover:bg-accent/50 transition-colors text-muted-foreground hover:text-foreground"
              onClick={onConfigure}
              title="Configure"
            >
              <Edit3 className="h-3 w-3" />
            </button>
            <button
              type="button"
              className="p-1 rounded hover:bg-destructive/10 transition-colors text-muted-foreground hover:text-destructive"
              onClick={onRemove}
              title="Remove"
            >
              <Trash2 className="h-3 w-3" />
            </button>
            <div className="cursor-move p-1 rounded hover:bg-accent/50 transition-colors text-muted-foreground">
              <Maximize2 className="h-3 w-3" />
            </div>
          </div>
        )}
      </CardHeader>
      <CardContent className="flex-1 overflow-hidden px-3 py-2">
        <WidgetRenderer widget={widget} schemas={schemas} logs={logs} logsLoading={logsLoading} />
      </CardContent>
    </Card>
  );
}

// ── Dashboard Page ────────────────────────────────────────────────────────────

export function DashboardPage() {
  const { t } = useTranslation();
  const { schemas } = useEntities();

  const [layout, setLayout] = useState<DashboardLayout>(loadLayout);
  const [editMode, setEditMode] = useState(false);
  const [addWidgetOpen, setAddWidgetOpen] = useState(false);
  const [configuringWidget, setConfiguringWidget] = useState<DashboardWidget | null>(null);
  const [containerWidth, setContainerWidth] = useState(1200);

  const [logs, setLogs] = useState<ExecutionLogEntry[]>([]);
  const [logsLoading, setLogsLoading] = useState(true);

  const containerRef = useRef<HTMLDivElement>(null);

  // Measure container width for grid layout
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setContainerWidth(entry.contentRect.width);
    });
    obs.observe(el);
    setContainerWidth(el.clientWidth);
    return () => obs.disconnect();
  }, []);

  // Load recent logs
  useEffect(() => {
    setLogsLoading(true);
    queryExecutionLogs({ pageSize: 20 })
      .then((result) => setLogs(result.items))
      .catch(() => setLogs([]))
      .finally(() => setLogsLoading(false));
  }, []);

  // Save layout on change
  const persistLayout = useCallback((next: DashboardLayout) => {
    setLayout(next);
    saveLayout(next);
  }, []);

  // Grid layout change handler (Layout = readonly LayoutItem[])
  const handleGridChange = useCallback(
    (
      newGrid: readonly {
        i: string;
        x: number;
        y: number;
        w: number;
        h: number;
        minW?: number;
        minH?: number;
      }[],
    ) => {
      setLayout((prev) => {
        const next = { ...prev, grid: [...newGrid] as GridItem[] };
        saveLayout(next);
        return next;
      });
    },
    [],
  );

  // Add widget
  const handleAddWidget = useCallback(
    (type: DashboardWidgetType) => {
      const id = `w${Date.now()}`;
      const newWidget: DashboardWidget = {
        id,
        type,
        config: {},
      };

      // Default grid sizes by type
      const defaultSizes: Record<
        DashboardWidgetType,
        Pick<GridItem, "w" | "h" | "minW" | "minH">
      > = {
        stat_card: { w: 4, h: 2, minW: 3, minH: 2 },
        chart: { w: 8, h: 4, minW: 4, minH: 3 },
        recent_activity: { w: 8, h: 5, minW: 4, minH: 3 },
        record_list: { w: 4, h: 4, minW: 3, minH: 3 },
        quick_actions: { w: 4, h: 2, minW: 3, minH: 2 },
      };

      const sizes = defaultSizes[type];
      const maxY = layout.grid.reduce((max, g) => Math.max(max, g.y + g.h), 0);

      const newGridItem: GridItem = {
        i: id,
        x: 0,
        y: maxY,
        ...sizes,
      };

      persistLayout({
        widgets: [...layout.widgets, newWidget],
        grid: [...layout.grid, newGridItem],
      });
    },
    [layout, persistLayout],
  );

  // Remove widget
  const handleRemoveWidget = useCallback(
    (id: string) => {
      persistLayout({
        widgets: layout.widgets.filter((w) => w.id !== id),
        grid: layout.grid.filter((g) => g.i !== id),
      });
    },
    [layout, persistLayout],
  );

  // Save widget config
  const handleSaveConfig = useCallback(
    (config: WidgetConfig) => {
      if (!configuringWidget) return;
      persistLayout({
        ...layout,
        widgets: layout.widgets.map((w) => (w.id === configuringWidget.id ? { ...w, config } : w)),
      });
      setConfiguringWidget(null);
    },
    [configuringWidget, layout, persistLayout],
  );

  // Reset to default
  const handleReset = useCallback(() => {
    const defaults = createDefaultLayout();
    persistLayout(defaults);
  }, [persistLayout]);

  const gridItems = layout.grid;

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">
            {t("workspace.title", { defaultValue: "Dashboard" })}
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {t("workspace.subtitle", { defaultValue: "Your customizable workspace" })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {editMode && (
            <>
              <Button variant="outline" size="sm" onClick={() => setAddWidgetOpen(true)}>
                <Plus className="h-3.5 w-3.5 mr-1" />
                Add Widget
              </Button>
              <Button variant="ghost" size="sm" onClick={handleReset}>
                Reset
              </Button>
            </>
          )}
          <Button
            variant={editMode ? "default" : "outline"}
            size="sm"
            onClick={() => setEditMode((e) => !e)}
          >
            <Edit3 className="h-3.5 w-3.5 mr-1" />
            {editMode ? "Done" : "Customize"}
          </Button>
        </div>
      </div>

      {/* Grid */}
      <div ref={containerRef} className="w-full">
        <GridLayout
          className="layout"
          layout={gridItems}
          cols={GRID_COLS}
          rowHeight={ROW_HEIGHT}
          width={containerWidth}
          isDraggable={editMode}
          isResizable={editMode}
          onLayoutChange={handleGridChange}
          draggableHandle=".cursor-move"
          margin={[12, 12] as [number, number]}
        >
          {layout.widgets.map((widget) => (
            <div key={widget.id} className="rounded-lg overflow-hidden">
              <DashboardWidgetCard
                widget={widget}
                editMode={editMode}
                schemas={schemas}
                logs={logs}
                logsLoading={logsLoading}
                onConfigure={() => setConfiguringWidget(widget)}
                onRemove={() => handleRemoveWidget(widget.id)}
              />
            </div>
          ))}
        </GridLayout>
      </div>

      {/* Add Widget Panel */}
      <AddWidgetPanel
        open={addWidgetOpen}
        onClose={() => setAddWidgetOpen(false)}
        onAdd={handleAddWidget}
      />

      {/* Widget Config Modal */}
      <WidgetConfigModal
        widget={configuringWidget}
        schemas={schemas}
        onSave={handleSaveConfig}
        onClose={() => setConfiguringWidget(null)}
      />
    </div>
  );
}
