/**
 * HealthMonitorPage — Admin page for system health monitoring.
 *
 * Displays health check results as status cards with auto-refresh.
 * Fetches from GET /health endpoint every 30 seconds.
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
  CheckCircleIcon,
  AlertTriangleIcon,
  XCircleIcon,
  DatabaseIcon,
  HeartIcon,
  LayersIcon,
  RadioIcon,
  HardDriveIcon,
  RefreshCwIcon,
  ServerIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

// ── Types ────────────────────────────────────────────────

interface HealthCheck {
  name: string;
  status: "healthy" | "degraded" | "unhealthy";
  message?: string;
  durationMs: number;
  metadata?: Record<string, unknown>;
}

interface SystemInfo {
  version: string;
  uptime: number;
  nodeVersion: string;
  platform: string;
  schemaCount: number;
  capabilityCount: number;
}

interface HealthResponse {
  status: "healthy" | "degraded" | "unhealthy";
  checks: HealthCheck[];
  timestamp: string;
  system?: SystemInfo;
}

// ── Constants ────────────────────────────────────────────

const REFRESH_INTERVAL_MS = 30_000;

const CHECK_ICONS: Record<string, React.ReactNode> = {
  liveness: <HeartIcon className="size-5" />,
  database: <DatabaseIcon className="size-5" />,
  schemas: <LayersIcon className="size-5" />,
  eventbus: <RadioIcon className="size-5" />,
  cache: <HardDriveIcon className="size-5" />,
};

const STATUS_COLORS: Record<string, string> = {
  healthy: "bg-emerald-500",
  degraded: "bg-amber-500",
  unhealthy: "bg-red-500",
};

const STATUS_BG: Record<string, string> = {
  healthy: "bg-emerald-50 dark:bg-emerald-950/30",
  degraded: "bg-amber-50 dark:bg-amber-950/30",
  unhealthy: "bg-red-50 dark:bg-red-950/30",
};

const STATUS_TEXT: Record<string, string> = {
  healthy: "text-emerald-700 dark:text-emerald-400",
  degraded: "text-amber-700 dark:text-amber-400",
  unhealthy: "text-red-700 dark:text-red-400",
};

// ── Helpers ──────────────────────────────────────────────

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (mins > 0) parts.push(`${mins}m`);
  parts.push(`${secs}s`);
  return parts.join(" ");
}

function formatDuration(ms: number): string {
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case "healthy":
      return <CheckCircleIcon className="size-5 text-emerald-500" />;
    case "degraded":
      return <AlertTriangleIcon className="size-5 text-amber-500" />;
    default:
      return <XCircleIcon className="size-5 text-red-500" />;
  }
}

// ── Component ────────────────────────────────────────────

export function HealthMonitorPage() {
  const { t } = useTranslation();
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchHealth = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/health");
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        // Even 503 returns health data — use it
        if (data?.checks) {
          setHealth(data as HealthResponse);
          setLastRefresh(new Date());
          return;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      setHealth(data as HealthResponse);
      setLastRefresh(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch and auto-refresh
  useEffect(() => {
    fetchHealth();
    intervalRef.current = setInterval(fetchHealth, REFRESH_INTERVAL_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchHealth]);

  return (
    <div className="w-full p-4 space-y-6">
      {/* Toolbar */}
      <div className="flex items-center justify-end gap-3">
        {lastRefresh && (
          <span className="text-xs text-muted-foreground">
            {t("health.lastRefresh")}: {lastRefresh.toLocaleTimeString()}
          </span>
        )}
        <Button variant="outline" size="sm" onClick={fetchHealth} disabled={loading}>
          <RefreshCwIcon className={`size-4 mr-1 ${loading ? "animate-spin" : ""}`} />
          {t("executionLog.refresh")}
        </Button>
      </div>

      {/* Overall status banner */}
      {health && (
        <div className={`rounded-lg p-4 flex items-center gap-3 ${STATUS_BG[health.status]}`}>
          <StatusIcon status={health.status} />
          <div>
            <div className={`font-medium ${STATUS_TEXT[health.status]}`}>
              {t(`health.overall.${health.status}`)}
            </div>
            <div className="text-xs text-muted-foreground">
              {health.checks.length} {t("health.checksRun")}
            </div>
          </div>
          <div className="ml-auto">
            <Badge
              variant={health.status === "healthy" ? "default" : health.status === "degraded" ? "secondary" : "destructive"}
            >
              {health.status.toUpperCase()}
            </Badge>
          </div>
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="rounded-lg p-4 bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-400 text-sm">
          {t("health.fetchError")}: {error}
        </div>
      )}

      {/* Health check cards */}
      {health && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {health.checks.map((check) => (
            <Card key={check.name} size="sm">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className={STATUS_TEXT[check.status]}>
                      {CHECK_ICONS[check.name] ?? <ServerIcon className="size-5" />}
                    </span>
                    <CardTitle className="capitalize">{check.name}</CardTitle>
                  </div>
                  <div className={`size-2.5 rounded-full ${STATUS_COLORS[check.status]}`} />
                </div>
                {check.message && <CardDescription>{check.message}</CardDescription>}
              </CardHeader>
              <CardContent>
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t("health.latency")}</span>
                    <span className="font-mono">{formatDuration(check.durationMs)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t("executionLog.status")}</span>
                    <Badge
                      variant={check.status === "healthy" ? "default" : check.status === "degraded" ? "secondary" : "destructive"}
                      className="text-[10px]"
                    >
                      {check.status}
                    </Badge>
                  </div>
                  {/* Show metadata if available */}
                  {check.metadata && Object.entries(check.metadata).map(([key, val]) => (
                    <div key={key} className="flex justify-between">
                      <span className="text-muted-foreground">{key}</span>
                      <span className="font-mono">{String(val)}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* System info */}
      {health?.system && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ServerIcon className="size-5" />
              {t("health.systemInfo")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <InfoItem label={t("health.version")} value={health.system.version} />
              <InfoItem label={t("health.uptime")} value={formatUptime(health.system.uptime)} />
              <InfoItem label={t("health.runtime")} value={`Bun ${health.system.nodeVersion}`} />
              <InfoItem label={t("health.platform")} value={health.system.platform} />
              <InfoItem label={t("health.schemaCount")} value={String(health.system.schemaCount)} />
              <InfoItem label={t("health.capabilityCount")} value={String(health.system.capabilityCount)} />
            </div>
          </CardContent>
        </Card>
      )}

      {/* Auto-refresh note */}
      <p className="text-xs text-muted-foreground text-center">
        {t("health.autoRefresh", { seconds: REFRESH_INTERVAL_MS / 1000 })}
      </p>
    </div>
  );
}

// ── Info item sub-component ──────────────────────────────

function InfoItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-sm font-medium font-mono">{value}</div>
    </div>
  );
}
