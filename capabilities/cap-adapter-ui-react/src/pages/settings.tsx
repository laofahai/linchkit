/**
 * SettingsPage — Displays current system configuration (read-only).
 *
 * Fetches sanitized config from /api/settings and displays it in
 * structured Card sections. No secrets are ever exposed.
 */

import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@linchkit/ui-kit/components";
import {
  ActivityIcon,
  BrainCircuitIcon,
  DatabaseIcon,
  GlobeIcon,
  InfoIcon,
  LayersIcon,
  NetworkIcon,
  RefreshCwIcon,
  ServerIcon,
  ShieldCheckIcon,
  UsersIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

// ── Types ────────────────────────────────────────────────

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

// ── Helpers ──────────────────────────────────────────────

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
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

export function SettingsPage() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/settings");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setSettings(json.data as SettingsData);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("settings.fetchError"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  if (loading && !settings) {
    return (
      <div className="p-6 flex items-center justify-center h-64">
        <RefreshCwIcon className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error && !settings) {
    return (
      <div className="p-6">
        <Card>
          <CardContent className="py-8 text-center text-destructive">{error}</CardContent>
        </Card>
      </div>
    );
  }

  if (!settings) return null;

  return (
    <div className="p-4 space-y-6">
      {/* Read-only notice */}
      <div className="flex items-start gap-2 rounded-lg border border-blue-200 dark:border-blue-900 bg-blue-50 dark:bg-blue-950/30 px-4 py-3 text-sm text-blue-700 dark:text-blue-300 break-words">
        <InfoIcon className="size-4 mt-0.5 shrink-0" />
        <span className="min-w-0">{t("settings.readOnlyNotice")}</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {/* System Info */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <ServerIcon className="size-4" />
              {t("settings.systemInfo")}
            </CardTitle>
            <CardDescription>{t("settings.systemInfoDesc")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-0">
            <SettingRow
              label={t("settings.version")}
              value={
                <Badge variant="outline" className="font-mono">
                  v{settings.general.version}
                </Badge>
              }
            />
            <SettingRow
              label={t("settings.uptime")}
              value={formatUptime(settings.general.uptime)}
              mono
            />
            <SettingRow
              label={t("settings.schemas")}
              value={settings.general.registeredSchemas}
              mono
            />
            <SettingRow
              label={t("settings.actions")}
              value={settings.general.registeredActions}
              mono
            />
            <SettingRow label={t("settings.rules")} value={settings.general.registeredRules} mono />
            <SettingRow label={t("settings.flows")} value={settings.general.registeredFlows} mono />
            <SettingRow
              label={t("settings.stateMachines")}
              value={settings.general.registeredStates}
              mono
            />
          </CardContent>
        </Card>

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
            <SettingRow label={t("settings.poolSize")} value={settings.database.poolSize ?? "N/A"} mono />
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

        {/* Capabilities */}
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
    </div>
  );
}
