/**
 * SystemOverviewPage — Merged admin page combining health monitoring and settings.
 *
 * Sections (top to bottom):
 * 1. Health status banner with refresh button
 * 2. Health check cards (Liveness / Schemas / Eventbus / Cache)
 * 3. System information (deduplicated from both sources)
 * 4. Configuration overview (read-only config cards from settings)
 * 5. Loaded capabilities list
 *
 * Data sources:
 * - GET /health — health checks + system info (auto-refreshes every 30s)
 * - GET /api/settings — sanitized config (fetched once)
 */

import {
  Alert,
  AlertDescription,
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

function formatUptimeMs(ms: number): string {
  return formatUptime(Math.floor(ms / 1000));
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

function StatusDot({ active }: { active: boolean }) {
  return (
    <span
      className={`inline-block size-2.5 rounded-full ${
        active
          ? "bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.5)]"
          : "bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.5)]"
      }`}
    />
  );
}

function InfoItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1 min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-sm font-medium font-mono truncate">{value}</div>
    </div>
  );
}

function SettingRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2 border-b border-border/50 last:border-0">
      <span className="text-sm text-muted-foreground shrink-0">{label}</span>
      <span
        className={`text-sm font-medium truncate max-w-[60%] sm:max-w-none ${mono ? "font-mono" : ""}`}
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
  const [settingsLoading, setSettingsLoading] = useState(true);
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
    setSettingsLoading(true);
    setSettingsError(null);
    try {
      const res = await fetch("/api/settings");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setSettings(json.data as SettingsData);
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : t("settings.fetchError"));
    } finally {
      setSettingsLoading(false);
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

  return (
    <div className="w-full p-4 space-y-6">
      {/* Read-only config notice */}
      <div className="flex items-start gap-2 rounded-lg border border-blue-200 dark:border-blue-900 bg-blue-50 dark:bg-blue-950/30 px-4 py-3 text-sm text-blue-700 dark:text-blue-300 break-words">
        <InfoIcon className="size-4 mt-0.5 shrink-0" />
        <span className="min-w-0">{t("settings.readOnlyNotice")}</span>
      </div>

      {/* 1. Health status banner */}
      <Alert variant="default" className={health ? STATUS_BG[health.status] : undefined}>
        {health ? <StatusIcon status={health.status} /> : <ClockIcon className="size-4" />}
        <AlertDescription className="flex items-center justify-between gap-3">
          <span className={`font-medium ${health ? STATUS_TEXT[health.status] : ""}`}>
            {health ? t(`health.overall.${health.status}`) : t("common.loading")}
          </span>
          <span className="ml-auto flex items-center gap-2 shrink-0">
            <span className="text-xs text-muted-foreground">
              {health && (
                <>
                  {health.checks.length} {t("health.checksRun")} &middot;{" "}
                </>
              )}
              {lastRefresh && `${t("health.lastRefresh")}: ${lastRefresh.toLocaleTimeString()}`}
            </span>
            <Button variant="outline" size="sm" onClick={fetchHealth} disabled={healthLoading}>
              <RefreshCwIcon className={`size-4 mr-1 ${healthLoading ? "animate-spin" : ""}`} />
              {t("executionLog.refresh")}
            </Button>
          </span>
        </AlertDescription>
      </Alert>

      {/* Health error banner */}
      {healthError && (
        <div className="rounded-lg p-4 bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-400 text-sm">
          {t("health.fetchError")}: {healthError}
        </div>
      )}

      {/* 2. Health check cards */}
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
                      variant={
                        check.status === "healthy"
                          ? "default"
                          : check.status === "degraded"
                            ? "secondary"
                            : "destructive"
                      }
                      className="text-[10px]"
                    >
                      {check.status}
                    </Badge>
                  </div>
                  {check.metadata &&
                    Object.entries(check.metadata).map(([key, val]) => (
                      <div key={key} className="flex justify-between gap-2">
                        <span className="text-muted-foreground shrink-0">{key}</span>
                        <span className="font-mono truncate">{String(val)}</span>
                      </div>
                    ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* 3. System information (merged, deduplicated) */}
      {(health?.system || settings) && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ServerIcon className="size-5" />
              {t("health.systemInfo")}
            </CardTitle>
            <CardDescription>{t("settings.systemInfoDesc")}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {/* Version — prefer health (live) over settings */}
              <InfoItem
                label={t("health.version")}
                value={`v${health?.system?.version ?? settings?.general.version ?? "-"}`}
              />
              {/* Uptime — health uses seconds, settings uses ms */}
              <InfoItem
                label={t("health.uptime")}
                value={
                  health?.system
                    ? formatUptime(health.system.uptime)
                    : settings
                      ? formatUptimeMs(settings.general.uptime)
                      : "-"
                }
              />
              {/* Platform + Runtime from health */}
              {health?.system && (
                <>
                  <InfoItem label={t("health.platform")} value={health.system.platform} />
                  <InfoItem
                    label={t("health.runtime")}
                    value={`Bun ${health.system.nodeVersion}`}
                  />
                </>
              )}
              {/* Registry counts from settings (more detailed) */}
              {settings && (
                <>
                  <InfoItem
                    label={t("settings.schemas")}
                    value={String(settings.general.registeredSchemas)}
                  />
                  <InfoItem
                    label={t("settings.actions")}
                    value={String(settings.general.registeredActions)}
                  />
                  <InfoItem
                    label={t("settings.rules")}
                    value={String(settings.general.registeredRules)}
                  />
                  <InfoItem
                    label={t("settings.flows")}
                    value={String(settings.general.registeredFlows)}
                  />
                  <InfoItem
                    label={t("settings.stateMachines")}
                    value={String(settings.general.registeredStates)}
                  />
                  <InfoItem
                    label={t("health.capabilityCount")}
                    value={String(
                      settings.general.capabilityCount ?? health?.system?.capabilityCount ?? 0,
                    )}
                  />
                </>
              )}
              {/* Fallback: if no settings but health has counts */}
              {!settings && health?.system && (
                <>
                  <InfoItem
                    label={t("health.schemaCount")}
                    value={String(health.system.schemaCount)}
                  />
                  <InfoItem
                    label={t("health.capabilityCount")}
                    value={String(health.system.capabilityCount)}
                  />
                </>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Settings error */}
      {settingsError && (
        <div className="rounded-lg p-4 bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-400 text-sm">
          {t("settings.fetchError")}: {settingsError}
        </div>
      )}

      {/* Settings loading */}
      {settingsLoading && !settings && (
        <div className="flex items-center justify-center h-32">
          <RefreshCwIcon className="size-5 animate-spin text-muted-foreground" />
        </div>
      )}

      {/* 4. Configuration overview */}
      {settings && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {/* Database */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <DatabaseIcon className="size-4" />
                {t("settings.database")}
              </CardTitle>
              <CardDescription>{t("settings.databaseDesc")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-0">
              <SettingRow
                label={t("settings.connectionStatus")}
                value={
                  <span className="flex items-center gap-2">
                    <StatusDot active={settings.database.configured} />
                    {settings.database.configured
                      ? t("settings.connected")
                      : t("settings.notConnected")}
                  </span>
                }
              />
              <SettingRow
                label={t("settings.provider")}
                value={<Badge variant="secondary">{settings.database.provider}</Badge>}
              />
              <SettingRow
                label={t("settings.poolSize")}
                value={settings.database.poolSize ?? "N/A"}
                mono
              />
              <SettingRow
                label={t("settings.debugMode")}
                value={settings.database.debug ? t("common.yes") : t("common.no")}
              />
            </CardContent>
          </Card>

          {/* AI Service */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <BrainCircuitIcon className="size-4" />
                {t("settings.aiService")}
              </CardTitle>
              <CardDescription>{t("settings.aiServiceDesc")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-0">
              <SettingRow
                label={t("settings.configured")}
                value={
                  <span className="flex items-center gap-2">
                    <StatusDot active={settings.ai.configured} />
                    {settings.ai.configured ? t("common.yes") : t("common.no")}
                  </span>
                }
              />
              <SettingRow
                label={t("settings.defaultProvider")}
                value={settings.ai.defaultProvider ?? t("common.none")}
                mono
              />
              <SettingRow
                label={t("settings.providers")}
                value={
                  settings.ai.providers.length > 0 ? (
                    <div className="flex gap-1 flex-wrap justify-end">
                      {settings.ai.providers.map((p) => (
                        <Badge key={p} variant="outline" className="text-xs">
                          {p}
                        </Badge>
                      ))}
                    </div>
                  ) : (
                    t("common.none")
                  )
                }
              />
            </CardContent>
          </Card>

          {/* Authentication */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <ShieldCheckIcon className="size-4" />
                {t("settings.authentication")}
              </CardTitle>
              <CardDescription>{t("settings.authenticationDesc")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-0">
              <SettingRow
                label={t("settings.enabled")}
                value={
                  <span className="flex items-center gap-2">
                    <StatusDot active={settings.auth.enabled} />
                    {settings.auth.enabled ? t("common.yes") : t("common.no")}
                  </span>
                }
              />
              <SettingRow
                label={t("settings.authProvider")}
                value={settings.auth.provider ?? t("common.none")}
                mono
              />
            </CardContent>
          </Card>

          {/* Tenancy */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <UsersIcon className="size-4" />
                {t("settings.tenancy")}
              </CardTitle>
              <CardDescription>{t("settings.tenancyDesc")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-0">
              <SettingRow
                label={t("settings.tenancyMode")}
                value={
                  <Badge variant={settings.tenancy.mode === "multi" ? "default" : "secondary"}>
                    {settings.tenancy.mode}
                  </Badge>
                }
              />
              <SettingRow
                label={t("settings.tenantCount")}
                value={settings.tenancy.tenantCount}
                mono
              />
            </CardContent>
          </Card>

          {/* Server */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <GlobeIcon className="size-4" />
                {t("settings.server")}
              </CardTitle>
              <CardDescription>{t("settings.serverDesc")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-0">
              <SettingRow label={t("settings.host")} value={settings.server.host} mono />
              <SettingRow label={t("settings.port")} value={settings.server.port} mono />
            </CardContent>
          </Card>

          {/* Subscriptions */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <NetworkIcon className="size-4" />
                {t("settings.subscriptions")}
              </CardTitle>
              <CardDescription>{t("settings.subscriptionsDesc")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-0">
              <SettingRow
                label={t("settings.enabled")}
                value={
                  <span className="flex items-center gap-2">
                    <StatusDot active={settings.subscription.enabled} />
                    {settings.subscription.enabled ? t("common.yes") : t("common.no")}
                  </span>
                }
              />
              <SettingRow
                label={t("settings.maxConnections")}
                value={settings.subscription.maxConnectionsPerUser}
                mono
              />
              <SettingRow
                label={t("settings.heartbeat")}
                value={`${settings.subscription.heartbeatInterval / 1000}s`}
                mono
              />
              <SettingRow
                label={t("settings.idleTimeout")}
                value={`${settings.subscription.idleTimeout / 1000}s`}
                mono
              />
              <SettingRow
                label={t("settings.bufferSize")}
                value={settings.subscription.maxBufferSize}
                mono
              />
            </CardContent>
          </Card>

          {/* Flow Engine */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <ActivityIcon className="size-4" />
                {t("settings.flowEngine")}
              </CardTitle>
              <CardDescription>{t("settings.flowEngineDesc")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-0">
              <SettingRow
                label={t("settings.configured")}
                value={
                  <span className="flex items-center gap-2">
                    <StatusDot active={settings.flow.configured} />
                    {settings.flow.configured ? t("common.yes") : t("common.no")}
                  </span>
                }
              />
              <SettingRow
                label={t("settings.engine")}
                value={<Badge variant="secondary">{settings.flow.engine}</Badge>}
              />
            </CardContent>
          </Card>

          {/* 5. Loaded Capabilities */}
          <Card className="md:col-span-2 lg:col-span-3">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <LayersIcon className="size-4" />
                {t("settings.capabilities")}
              </CardTitle>
              <CardDescription>{t("settings.capabilitiesDesc")}</CardDescription>
            </CardHeader>
            <CardContent>
              {settings.general.capabilities.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {settings.general.capabilities.map((cap) => (
                    <Badge key={cap} variant="outline" className="font-mono text-xs">
                      {cap}
                    </Badge>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">{t("settings.noCapabilities")}</p>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Auto-refresh note */}
      <p className="text-xs text-muted-foreground text-center">
        {t("health.autoRefresh", { seconds: REFRESH_INTERVAL_MS / 1000 })}
      </p>
    </div>
  );
}
