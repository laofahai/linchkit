/**
 * SystemOverviewPage — Unified admin dashboard combining health monitoring,
 * system KPIs, and configuration overview.
 *
 * Layout:
 *   - Info banner (config is read-only)
 *   - Section A: Runtime Status — health banner + 4 compact health check cards
 *   - Section B: System KPIs — large-number metric cards in a single row
 *   - Section C: Configuration Grid — 3-column card grid for config areas
 *   - Footer: auto-refresh note
 *
 * Data sources:
 *   - GET /health — health checks + system info (auto-refreshes every 30s)
 *   - GET /api/settings — sanitized config (fetched once)
 */

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@linchkit/ui-kit/components";
import {
  ActivityIcon,
  AlertTriangleIcon,
  BrainCircuitIcon,
  CheckCircleIcon,
  ClockIcon,
  DatabaseIcon,
  GlobeIcon,
  HardDriveIcon,
  HeartIcon,
  InfoIcon,
  LayersIcon,
  NetworkIcon,
  RadioIcon,
  RefreshCwIcon,
  ServerIcon,
  ShieldCheckIcon,
  UsersIcon,
  XCircleIcon,
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

interface SettingsData {
  general: {
    version: string;
    uptime: number;
    registeredSchemas: number;
    registeredActions: number;
    registeredRules: number;
    registeredFlows: number;
    registeredStates: number;
    capabilityCount: number;
    capabilities: string[];
  };
  database: {
    configured: boolean;
    provider: string;
    poolSize: number | null;
    debug: boolean;
  };
  ai: {
    configured: boolean;
    defaultProvider: string | null;
    providers: string[];
  };
  auth: {
    enabled: boolean;
    provider: string | null;
  };
  tenancy: {
    mode: string;
    tenantCount: number;
  };
  server: {
    port: number;
    host: string;
  };
  subscription: {
    enabled: boolean;
    maxConnectionsPerUser: number;
    heartbeatInterval: number;
    idleTimeout: number;
    maxBufferSize: number;
  };
  flow: {
    configured: boolean;
    engine: string;
  };
}

// ── Constants ────────────────────────────────────────────

const REFRESH_INTERVAL_MS = 30_000;

const CHECK_ICONS: Record<string, React.ReactNode> = {
  liveness: <HeartIcon className="size-4" />,
  database: <DatabaseIcon className="size-4" />,
  schemas: <LayersIcon className="size-4" />,
  eventbus: <RadioIcon className="size-4" />,
  cache: <HardDriveIcon className="size-4" />,
};

const STATUS_BORDER: Record<string, string> = {
  healthy: "border-emerald-200 dark:border-emerald-800",
  degraded: "border-amber-200 dark:border-amber-800",
  unhealthy: "border-red-200 dark:border-red-800",
};

const STATUS_DOT: Record<string, string> = {
  healthy: "bg-emerald-500",
  degraded: "bg-amber-500",
  unhealthy: "bg-red-500",
};

const BANNER_BG: Record<string, string> = {
  healthy: "bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800",
  degraded: "bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800",
  unhealthy: "bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800",
};

const BANNER_TEXT: Record<string, string> = {
  healthy: "text-emerald-700 dark:text-emerald-400",
  degraded: "text-amber-700 dark:text-amber-400",
  unhealthy: "text-red-700 dark:text-red-400",
};

// ── Helpers ──────────────────────────────────────────────

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (mins > 0) parts.push(`${mins}m`);
  if (parts.length === 0) parts.push(`${Math.floor(seconds % 60)}s`);
  return parts.join(" ");
}

function formatUptimeMs(ms: number): string {
  return formatUptime(Math.floor(ms / 1000));
}

function formatDuration(ms: number): string {
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function BannerIcon({ status }: { status: string }) {
  switch (status) {
    case "healthy":
      return <CheckCircleIcon className="size-5 text-emerald-500 shrink-0" />;
    case "degraded":
      return <AlertTriangleIcon className="size-5 text-amber-500 shrink-0" />;
    default:
      return <XCircleIcon className="size-5 text-red-500 shrink-0" />;
  }
}

function StatusDot({ active }: { active: boolean }) {
  return (
    <span
      className={`inline-block size-2 rounded-full ${
        active
          ? "bg-emerald-500 shadow-[0_0_4px_rgba(34,197,94,0.4)]"
          : "bg-red-500 shadow-[0_0_4px_rgba(239,68,68,0.4)]"
      }`}
    />
  );
}

/** Compact key-value row for config cards */
function ConfigRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-x-3 py-1.5 border-b border-border/40 last:border-0">
      <span className="text-xs text-muted-foreground shrink-0">{label}</span>
      <span
        className={`text-xs font-medium truncate max-w-[55%] text-right ${mono ? "font-mono" : ""}`}
      >
        {value}
      </span>
    </div>
  );
}

// ── Component ────────────────────────────────────────────

export function SystemOverviewPage() {
  const { t } = useTranslation();

  // Health state
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Settings state
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const fetchHealth = useCallback(async () => {
    setHealthLoading(true);
    setHealthError(null);
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
      setHealthError(err instanceof Error ? err.message : String(err));
    } finally {
      setHealthLoading(false);
    }
  }, []);

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setSettings(json.data as SettingsData);
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : t("settings.fetchError"));
    }
  }, [t]);

  // Initial fetch and auto-refresh for health
  useEffect(() => {
    fetchHealth();
    intervalRef.current = setInterval(fetchHealth, REFRESH_INTERVAL_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchHealth]);

  // Fetch settings once
  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  // Derive KPI values from best available source
  const version = health?.system?.version ?? settings?.general.version;
  const uptimeStr = health?.system
    ? formatUptime(health.system.uptime)
    : settings
      ? formatUptimeMs(settings.general.uptime)
      : null;
  const platform = health?.system
    ? `${health.system.platform} / Bun ${health.system.nodeVersion}`
    : null;
  const schemaCount = settings?.general.registeredSchemas ?? health?.system?.schemaCount;
  const actionCount = settings?.general.registeredActions;
  const capCount = settings?.general.capabilityCount ?? health?.system?.capabilityCount;

  return (
    <div className="w-full p-4 space-y-5 max-w-7xl mx-auto">
      {/* ── Info banner ──────────────────────────────────── */}
      <div className="flex items-start gap-2 rounded-md border border-blue-200 dark:border-blue-900 bg-blue-50/60 dark:bg-blue-950/20 px-3 py-2 text-xs text-blue-600 dark:text-blue-400">
        <InfoIcon className="size-3.5 mt-0.5 shrink-0" />
        <span>{t("settings.readOnlyNotice")}</span>
      </div>

      {/* ── Section A: Runtime Status ────────────────────── */}

      {/* Health status banner */}
      {health && (
        <div
          className={`flex items-center gap-3 rounded-lg border px-4 py-3 ${BANNER_BG[health.status]}`}
        >
          <BannerIcon status={health.status} />
          <span className={`text-sm font-medium ${BANNER_TEXT[health.status]}`}>
            {t(`health.overall.${health.status}`)}
          </span>
          <span className="ml-auto flex items-center gap-3 shrink-0">
            <span className="text-xs text-muted-foreground hidden sm:inline">
              {lastRefresh && `${lastRefresh.toLocaleTimeString()}`}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={fetchHealth}
              disabled={healthLoading}
              className="h-7 px-2"
            >
              <RefreshCwIcon className={`size-3.5 ${healthLoading ? "animate-spin" : ""}`} />
            </Button>
          </span>
        </div>
      )}

      {/* Health loading state */}
      {!health && !healthError && (
        <div className="flex items-center gap-2 rounded-lg border px-4 py-3 text-sm text-muted-foreground">
          <ClockIcon className="size-4" />
          {t("common.loading")}
        </div>
      )}

      {/* Health error */}
      {healthError && (
        <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 px-4 py-3 text-sm text-red-600 dark:text-red-400">
          {t("health.fetchError")}: {healthError}
        </div>
      )}

      {/* Health check cards — 4 in a row on large screens */}
      {health && (
        <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
          {health.checks.map((check) => (
            <Card
              key={check.name}
              className={`border ${STATUS_BORDER[check.status]} transition-colors`}
            >
              <CardContent className="p-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">
                      {CHECK_ICONS[check.name] ?? <ServerIcon className="size-4" />}
                    </span>
                    <span className="text-sm font-medium capitalize">{check.name}</span>
                  </div>
                  <div className={`size-2 rounded-full ${STATUS_DOT[check.status]}`} />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">{t("health.latency")}</span>
                  <span className="text-xs font-mono">{formatDuration(check.durationMs)}</span>
                </div>
                {check.message && (
                  <p className="text-xs text-muted-foreground mt-1 truncate">{check.message}</p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* ── Section B: System KPIs ───────────────────────── */}
      {(health?.system || settings) && (
        <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
          {version != null && <KpiCard label={t("health.version")} value={`v${version}`} />}
          {uptimeStr != null && <KpiCard label={t("health.uptime")} value={uptimeStr} />}
          {platform != null && <KpiCard label={t("health.platform")} value={platform} small />}
          {schemaCount != null && (
            <KpiCard label={t("settings.schemas")} value={String(schemaCount)} />
          )}
          {actionCount != null && (
            <KpiCard label={t("settings.actions")} value={String(actionCount)} />
          )}
          {capCount != null && (
            <KpiCard label={t("health.capabilityCount")} value={String(capCount)} />
          )}
        </div>
      )}

      {/* ── Settings error ───────────────────────────────── */}
      {settingsError && (
        <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 px-4 py-3 text-sm text-red-600 dark:text-red-400">
          {t("settings.fetchError")}: {settingsError}
        </div>
      )}

      {/* ── Section C: Configuration Grid ────────────────── */}
      {settings && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {/* Database */}
          <ConfigCard icon={<DatabaseIcon className="size-4" />} title={t("settings.database")}>
            <ConfigRow
              label={t("settings.connectionStatus")}
              value={
                <span className="flex items-center gap-1.5">
                  <StatusDot active={settings.database.configured} />
                  {settings.database.configured
                    ? t("settings.connected")
                    : t("settings.notConnected")}
                </span>
              }
            />
            <ConfigRow
              label={t("settings.provider")}
              value={
                <Badge variant="secondary" className="text-[10px] h-4 px-1.5">
                  {settings.database.provider}
                </Badge>
              }
            />
            <ConfigRow
              label={t("settings.poolSize")}
              value={settings.database.poolSize ?? "N/A"}
              mono
            />
            <ConfigRow
              label={t("settings.debugMode")}
              value={settings.database.debug ? t("common.yes") : t("common.no")}
            />
          </ConfigCard>

          {/* AI Service */}
          <ConfigCard
            icon={<BrainCircuitIcon className="size-4" />}
            title={t("settings.aiService")}
          >
            <ConfigRow
              label={t("settings.configured")}
              value={
                <span className="flex items-center gap-1.5">
                  <StatusDot active={settings.ai.configured} />
                  {settings.ai.configured ? t("common.yes") : t("common.no")}
                </span>
              }
            />
            <ConfigRow
              label={t("settings.defaultProvider")}
              value={settings.ai.defaultProvider ?? t("common.none")}
              mono
            />
            {settings.ai.providers.length > 0 && (
              <ConfigRow
                label={t("settings.providers")}
                value={
                  <div className="flex gap-1 flex-wrap justify-end">
                    {settings.ai.providers.map((p) => (
                      <Badge key={p} variant="outline" className="text-[10px] h-4 px-1">
                        {p}
                      </Badge>
                    ))}
                  </div>
                }
              />
            )}
          </ConfigCard>

          {/* Authentication */}
          <ConfigCard
            icon={<ShieldCheckIcon className="size-4" />}
            title={t("settings.authentication")}
          >
            <ConfigRow
              label={t("settings.enabled")}
              value={
                <span className="flex items-center gap-1.5">
                  <StatusDot active={settings.auth.enabled} />
                  {settings.auth.enabled ? t("common.yes") : t("common.no")}
                </span>
              }
            />
            <ConfigRow
              label={t("settings.authProvider")}
              value={settings.auth.provider ?? t("common.none")}
              mono
            />
          </ConfigCard>

          {/* Tenancy */}
          <ConfigCard icon={<UsersIcon className="size-4" />} title={t("settings.tenancy")}>
            <ConfigRow
              label={t("settings.tenancyMode")}
              value={
                <Badge
                  variant={settings.tenancy.mode === "multi" ? "default" : "secondary"}
                  className="text-[10px] h-4 px-1.5"
                >
                  {settings.tenancy.mode}
                </Badge>
              }
            />
            <ConfigRow
              label={t("settings.tenantCount")}
              value={settings.tenancy.tenantCount}
              mono
            />
          </ConfigCard>

          {/* Server */}
          <ConfigCard icon={<GlobeIcon className="size-4" />} title={t("settings.server")}>
            <ConfigRow label={t("settings.host")} value={settings.server.host} mono />
            <ConfigRow label={t("settings.port")} value={settings.server.port} mono />
          </ConfigCard>

          {/* Subscriptions */}
          <ConfigCard icon={<NetworkIcon className="size-4" />} title={t("settings.subscriptions")}>
            <ConfigRow
              label={t("settings.enabled")}
              value={
                <span className="flex items-center gap-1.5">
                  <StatusDot active={settings.subscription.enabled} />
                  {settings.subscription.enabled ? t("common.yes") : t("common.no")}
                </span>
              }
            />
            <ConfigRow
              label={t("settings.maxConnections")}
              value={settings.subscription.maxConnectionsPerUser}
              mono
            />
            <ConfigRow
              label={t("settings.heartbeat")}
              value={`${settings.subscription.heartbeatInterval / 1000}s`}
              mono
            />
          </ConfigCard>

          {/* Flow Engine */}
          <ConfigCard icon={<ActivityIcon className="size-4" />} title={t("settings.flowEngine")}>
            <ConfigRow
              label={t("settings.configured")}
              value={
                <span className="flex items-center gap-1.5">
                  <StatusDot active={settings.flow.configured} />
                  {settings.flow.configured ? t("common.yes") : t("common.no")}
                </span>
              }
            />
            <ConfigRow
              label={t("settings.engine")}
              value={
                <Badge variant="secondary" className="text-[10px] h-4 px-1.5">
                  {settings.flow.engine}
                </Badge>
              }
            />
          </ConfigCard>

          {/* Loaded Capabilities — spans full width */}
          <Card className="md:col-span-2 lg:col-span-2">
            <CardHeader className="pb-2 pt-3 px-4">
              <CardTitle className="text-sm flex items-center gap-2 font-medium">
                <LayersIcon className="size-4 text-muted-foreground" />
                {t("settings.capabilities")}
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-3">
              {settings.general.capabilities.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {settings.general.capabilities.map((cap) => (
                    <Badge key={cap} variant="outline" className="font-mono text-[10px] h-5">
                      {cap}
                    </Badge>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">{t("settings.noCapabilities")}</p>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* ── Footer: auto-refresh note ────────────────────── */}
      <p className="text-[11px] text-muted-foreground text-center pt-2">
        {t("health.autoRefresh", { seconds: REFRESH_INTERVAL_MS / 1000 })}
      </p>
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────

/** Large-number KPI metric card */
function KpiCard({ label, value, small }: { label: string; value: string; small?: boolean }) {
  return (
    <Card>
      <CardContent className="p-3 text-center">
        <div
          className={`font-semibold font-mono truncate ${small ? "text-sm" : "text-xl"}`}
          title={value}
        >
          {value}
        </div>
        <div className="text-[11px] text-muted-foreground mt-0.5 truncate">{label}</div>
      </CardContent>
    </Card>
  );
}

/** Compact configuration card wrapper */
function ConfigCard({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-1 pt-3 px-4">
        <CardTitle className="text-sm flex items-center gap-2 font-medium">
          <span className="text-muted-foreground">{icon}</span>
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-3 space-y-0">{children}</CardContent>
    </Card>
  );
}
