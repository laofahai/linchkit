/**
 * SystemOverviewPage — Admin dashboard showing health status and system KPIs.
 *
 * Design principles:
 *   - Core module info only — no capability-specific content hardcoded
 *   - Full-width layout
 *   - Capabilities can extend via `systemStatusWidgets` extension point (future)
 *
 * Layout:
 *   - Section A: Health banner + health check cards
 *   - Section B: System KPIs (aggregated totals)
 *   - Section C: Capability list (compact, click for details dialog)
 *   - Footer: auto-refresh note
 *
 * Data sources:
 *   - GET /health — health checks + system info (auto-refreshes every 30s)
 *   - GET /api/settings — aggregated stats (fetched once)
 */

import {
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@linchkit/ui-kit/components";
import {
  AlertTriangleIcon,
  BoxIcon,
  CheckCircleIcon,
  ClockIcon,
  DatabaseIcon,
  FileCode2Icon,
  HardDriveIcon,
  HeartIcon,
  LayersIcon,
  RadioIcon,
  RefreshCwIcon,
  ServerIcon,
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

interface SettingsGeneral {
  version: string;
  uptime: number;
  registeredSchemas: number;
  registeredActions: number;
  registeredRules: number;
  registeredFlows: number;
  registeredStates: number;
  registeredLinks?: number;
  registeredEventHandlers?: number;
  capabilityCount: number;
  capabilities: string[];
  capabilityDetails?: CapabilityDetail[];
}

interface CapabilityDetail {
  name: string;
  type: string;
  label?: string;
  description?: string;
  schemas: number;
  actions: number;
  rules: number;
  flows: number;
  states: number;
  links: number;
  eventHandlers: number;
}

interface SettingsData {
  general: SettingsGeneral;
  database?: Record<string, unknown>;
  ai?: Record<string, unknown>;
  auth?: Record<string, unknown>;
  tenancy?: Record<string, unknown>;
  server?: Record<string, unknown>;
  subscription?: Record<string, unknown>;
  flow?: Record<string, unknown>;
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

// ── Component ────────────────────────────────────────────

export function SystemOverviewPage() {
  const { t } = useTranslation();

  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  // Capability detail dialog
  const [selectedCap, setSelectedCap] = useState<CapabilityDetail | null>(null);

  // Startup config dialog
  const [configOpen, setConfigOpen] = useState(false);

  const fetchHealth = useCallback(async () => {
    setHealthLoading(true);
    setHealthError(null);
    try {
      const res = await fetch("/health");
      const data = await res.json().catch(() => null);
      if (data?.checks) {
        setHealth(data as HealthResponse);
        setLastRefresh(new Date());
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
      setSettingsError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    fetchHealth();
    intervalRef.current = setInterval(fetchHealth, REFRESH_INTERVAL_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchHealth]);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const gen = settings?.general;
  const version = health?.system?.version ?? gen?.version;
  const uptimeStr = health?.system
    ? formatUptime(health.system.uptime)
    : gen
      ? formatUptimeMs(gen.uptime)
      : null;
  const platform = health?.system
    ? `${health.system.platform} / Bun ${health.system.nodeVersion}`
    : null;

  // Build KPI list from available data
  const kpis: { label: string; value: string; small?: boolean }[] = [];
  if (version) kpis.push({ label: t("health.version"), value: `v${version}` });
  if (uptimeStr) kpis.push({ label: t("health.uptime"), value: uptimeStr });
  if (platform) kpis.push({ label: t("health.platform"), value: platform, small: true });
  if (gen) {
    kpis.push({ label: t("settings.schemas"), value: String(gen.registeredSchemas) });
    kpis.push({ label: t("settings.actions"), value: String(gen.registeredActions) });
    kpis.push({ label: t("settings.rules"), value: String(gen.registeredRules) });
    kpis.push({ label: t("settings.flows"), value: String(gen.registeredFlows) });
    kpis.push({ label: t("settings.stateMachines"), value: String(gen.registeredStates) });
    if (gen.registeredLinks != null) {
      kpis.push({ label: t("systemOverview.links"), value: String(gen.registeredLinks) });
    }
    if (gen.registeredEventHandlers != null) {
      kpis.push({
        label: t("systemOverview.eventHandlers"),
        value: String(gen.registeredEventHandlers),
      });
    }
  }

  const capDetails = gen?.capabilityDetails ?? [];

  return (
    <div className="w-full p-4 space-y-5">
      {/* ── Section A: Health Status ───────────────────── */}

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
              {lastRefresh && lastRefresh.toLocaleTimeString()}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfigOpen(true)}
              className="h-7 px-2"
              title={t("systemOverview.startupConfig")}
            >
              <FileCode2Icon className="size-3.5" />
            </Button>
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

      {!health && !healthError && (
        <div className="flex items-center gap-2 rounded-lg border px-4 py-3 text-sm text-muted-foreground">
          <ClockIcon className="size-4" />
          {t("common.loading")}
        </div>
      )}

      {healthError && (
        <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 px-4 py-3 text-sm text-red-600 dark:text-red-400">
          {t("health.fetchError")}: {healthError}
        </div>
      )}

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

      {/* ── Section B: System KPIs ──────────────────────── */}

      {kpis.length > 0 && (
        <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
          {kpis.map((kpi) => (
            <KpiCard key={kpi.label} label={kpi.label} value={kpi.value} small={kpi.small} />
          ))}
        </div>
      )}

      {settingsError && (
        <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 px-4 py-3 text-sm text-red-600 dark:text-red-400">
          {settingsError}
        </div>
      )}

      {/* ── Section C: Capability List ──────────────────── */}

      {gen && gen.capabilities.length > 0 && (
        <Card>
          <CardContent className="p-4">
            <h3 className="text-sm font-semibold text-muted-foreground mb-3">
              {t("systemOverview.capabilityPanels")} ({gen.capabilities.length})
            </h3>
            <div className="flex flex-wrap gap-2">
              {gen.capabilities.map((name) => {
                const detail = capDetails.find((c) => c.name === name);
                return (
                  <Badge
                    key={name}
                    variant="outline"
                    className="cursor-pointer hover:bg-muted transition-colors font-mono text-xs px-2.5 py-1"
                    onClick={() => {
                      if (detail) setSelectedCap(detail);
                    }}
                  >
                    {name}
                    {detail?.type === "adapter" && (
                      <span className="ml-1 text-[10px] text-muted-foreground">adapter</span>
                    )}
                  </Badge>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Capability Detail Dialog ────────────────────── */}

      <Dialog open={selectedCap !== null} onOpenChange={() => setSelectedCap(null)}>
        <DialogContent>
          {selectedCap && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <BoxIcon className="size-4" />
                  <span className="font-mono">{selectedCap.name}</span>
                  <Badge
                    variant={selectedCap.type === "adapter" ? "default" : "secondary"}
                    className="text-[10px] h-4 px-1.5 ml-1"
                  >
                    {selectedCap.type}
                  </Badge>
                </DialogTitle>
              </DialogHeader>
              {selectedCap.description && (
                <p className="text-sm text-muted-foreground">{selectedCap.description}</p>
              )}
              <div className="grid grid-cols-2 gap-2 text-sm">
                <StatRow label={t("settings.schemas")} value={selectedCap.schemas} />
                <StatRow label={t("settings.actions")} value={selectedCap.actions} />
                <StatRow label={t("settings.rules")} value={selectedCap.rules} />
                <StatRow label={t("settings.flows")} value={selectedCap.flows} />
                <StatRow label={t("settings.stateMachines")} value={selectedCap.states} />
                <StatRow label={t("systemOverview.links")} value={selectedCap.links} />
                <StatRow
                  label={t("systemOverview.eventHandlers")}
                  value={selectedCap.eventHandlers}
                />
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Startup Config Dialog ─────────────────────── */}

      <StartupConfigDialog open={configOpen} onOpenChange={setConfigOpen} settings={settings} />

      {/* ── Footer ──────────────────────────────────────── */}

      <p className="text-[11px] text-muted-foreground text-center pt-2">
        {t("health.autoRefresh", { seconds: REFRESH_INTERVAL_MS / 1000 })}
      </p>
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────

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

function StatRow({ label, value }: { label: string; value: number }) {
  if (value === 0) return null;
  return (
    <div className="flex items-center justify-between py-1 px-2 rounded bg-muted/50">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono font-medium">{value}</span>
    </div>
  );
}

// ── Startup Config Dialog ──────────────────────────────

interface ConfigSectionDef {
  key: keyof SettingsData;
  labelKey: string;
}

const CONFIG_SECTIONS: ConfigSectionDef[] = [
  { key: "database", labelKey: "systemOverview.startupConfigDatabase" },
  { key: "ai", labelKey: "systemOverview.startupConfigAi" },
  { key: "auth", labelKey: "systemOverview.startupConfigAuth" },
  { key: "tenancy", labelKey: "systemOverview.startupConfigTenancy" },
  { key: "server", labelKey: "systemOverview.startupConfigServer" },
  { key: "subscription", labelKey: "systemOverview.startupConfigSubscription" },
  { key: "flow", labelKey: "systemOverview.startupConfigFlow" },
];

function ConfigValue({ value }: { value: unknown }) {
  if (typeof value === "boolean") {
    return (
      <span
        className={`inline-block size-2 rounded-full ${value ? "bg-emerald-500" : "bg-red-500"}`}
      />
    );
  }
  if (Array.isArray(value)) {
    return (
      <span className="flex flex-wrap gap-1 justify-end">
        {value.map((item, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: simple display list
          <Badge key={i} variant="secondary" className="text-[10px] h-4 px-1.5">
            {String(item)}
          </Badge>
        ))}
      </span>
    );
  }
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground italic">null</span>;
  }
  if (typeof value === "object") {
    return <span className="font-mono text-xs truncate max-w-[60%]">{JSON.stringify(value)}</span>;
  }
  return <span className="font-mono text-xs">{String(value)}</span>;
}

function StartupConfigDialog({
  open,
  onOpenChange,
  settings,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: SettingsData | null;
}) {
  const { t } = useTranslation();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileCode2Icon className="size-4" />
            {t("systemOverview.startupConfig")}
          </DialogTitle>
        </DialogHeader>

        {!settings ? (
          <p className="text-sm text-muted-foreground text-center py-6">{t("common.loading")}</p>
        ) : (
          <div className="space-y-4">
            {CONFIG_SECTIONS.map(({ key, labelKey }) => {
              const data = settings[key];
              if (!data || typeof data !== "object") return null;
              const entries = Object.entries(data as Record<string, unknown>);
              if (entries.length === 0) return null;
              return (
                <div key={key}>
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">
                    {t(labelKey)}
                  </h4>
                  <div className="space-y-0.5">
                    {entries.map(([k, v]) => (
                      <div
                        key={k}
                        className="flex items-center justify-between py-1 px-2 rounded hover:bg-muted/50 text-sm"
                      >
                        <span className="text-muted-foreground">{k}</span>
                        <ConfigValue value={v} />
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <p className="text-[11px] text-muted-foreground text-center pt-2 border-t mt-2">
          {t("systemOverview.startupConfigHint")}
        </p>
      </DialogContent>
    </Dialog>
  );
}
