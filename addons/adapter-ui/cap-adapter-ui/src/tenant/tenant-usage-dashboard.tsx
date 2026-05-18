/**
 * TenantUsageDashboard — read-only KPI cards summarising tenant usage
 * for the current billing period.
 *
 * Three Cards (requests, storage, AI tokens) plus a placeholder line
 * for a future detailed chart. Values come from the
 * `useTenantSelfService()` snapshot, formatted via tenant-helpers.
 */

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@linchkit/ui-kit/components";
import { useTranslation } from "react-i18next";
import { formatBytes, formatUsageRatio } from "./tenant-helpers";
import type { TenantUsageStats } from "./tenant-self-service-types";

export interface TenantUsageDashboardProps {
  usage: TenantUsageStats;
}

interface KpiCardProps {
  title: string;
  primary: string;
  secondary: string;
  ratio: string;
}

function KpiCard({ title, primary, secondary, ratio }: KpiCardProps) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{title}</CardDescription>
        <CardTitle className="text-2xl tabular-nums">{primary}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-baseline justify-between text-xs text-muted-foreground">
          <span>{secondary}</span>
          <span className="font-medium">{ratio}</span>
        </div>
      </CardContent>
    </Card>
  );
}

/** Format an ISO range like `"May 1 – May 31, 2026"`. Falls back gracefully. */
function formatPeriod(startIso: string, endIso: string): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return `${startIso} – ${endIso}`;
  }
  return `${start.toLocaleDateString()} – ${end.toLocaleDateString()}`;
}

export function TenantUsageDashboard({ usage }: TenantUsageDashboardProps) {
  const { t } = useTranslation();

  const requestsRatio = formatUsageRatio(usage.requests.used, usage.requests.limit);
  const storageRatio = formatUsageRatio(usage.storageBytes.used, usage.storageBytes.limit);
  const tokensRatio = formatUsageRatio(usage.aiTokens.used, usage.aiTokens.limit);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">{t("tenant.usage.title", "Usage")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("tenant.usage.period", "Billing period")}:{" "}
          {formatPeriod(usage.periodStart, usage.periodEnd)}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <KpiCard
          title={t("tenant.usage.requests", "API requests")}
          primary={usage.requests.used.toLocaleString()}
          secondary={t("tenant.usage.outOf", "of {{limit}}", {
            limit: usage.requests.limit.toLocaleString(),
          })}
          ratio={requestsRatio}
        />
        <KpiCard
          title={t("tenant.usage.storage", "Storage")}
          primary={formatBytes(usage.storageBytes.used)}
          secondary={t("tenant.usage.outOf", "of {{limit}}", {
            limit: formatBytes(usage.storageBytes.limit),
          })}
          ratio={storageRatio}
        />
        <KpiCard
          title={t("tenant.usage.aiTokens", "AI tokens")}
          primary={usage.aiTokens.used.toLocaleString()}
          secondary={t("tenant.usage.outOf", "of {{limit}}", {
            limit: usage.aiTokens.limit.toLocaleString(),
          })}
          ratio={tokensRatio}
        />
      </div>

      <p className="text-sm text-muted-foreground italic">
        {t("tenant.usage.placeholder", "Detailed usage coming soon.")}
      </p>
    </div>
  );
}
