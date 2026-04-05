/**
 * MCP Dashboard — Overview page showing stats and recent activity.
 *
 * Route: /admin/mcp
 */

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@linchkit/ui-kit/components";
import { ActivityIcon, ArrowRightIcon, PlugIcon, RadioIcon, ZapIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { McpClient } from "../lib/api";
import { fetchMcpClients } from "../lib/api";

// ── Demo data for recent activity (stub) ───────────────

interface RecentActivity {
  id: string;
  tool: string;
  clientName: string;
  timestamp: string;
  status: "success" | "error";
}

const DEMO_ACTIVITY: RecentActivity[] = [
  {
    id: "1",
    tool: "list_entities",
    clientName: "Claude Desktop",
    timestamp: new Date(Date.now() - 120_000).toISOString(),
    status: "success",
  },
  {
    id: "2",
    tool: "execute_action",
    clientName: "Cursor",
    timestamp: new Date(Date.now() - 300_000).toISOString(),
    status: "success",
  },
  {
    id: "3",
    tool: "query",
    clientName: "Claude Desktop",
    timestamp: new Date(Date.now() - 600_000).toISOString(),
    status: "error",
  },
];

// ── Component ──────────────────────────────────────────

export function McpDashboard() {
  const { t } = useTranslation();
  const [clients, setClients] = useState<McpClient[]>([]);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchMcpClients();
      setClients(data);
    } catch {
      // Graceful fallback — dashboard still renders with zero counts
      setClients([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const activeCount = clients.filter((c) => c.enabled).length;

  return (
    <div className="p-4 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-lg font-semibold">{t("mcp.admin.title")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("mcp.admin.dashboard.subtitle", "Manage MCP clients and monitor activity")}
        </p>
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              {t("mcp.admin.dashboard.activeClients")}
            </CardTitle>
            <PlugIcon className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{loading ? "—" : activeCount}</div>
            <p className="text-xs text-muted-foreground">
              {t("mcp.admin.dashboard.totalClients", {
                count: clients.length,
                defaultValue: "{{count}} total registered",
              })}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              {t("mcp.admin.dashboard.totalRequests")}
            </CardTitle>
            <ZapIcon className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">—</div>
            <p className="text-xs text-muted-foreground">
              {t("mcp.admin.dashboard.requestsStub", "Stats coming soon")}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">
              {t("mcp.admin.dashboard.activeSessions")}
            </CardTitle>
            <RadioIcon className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">—</div>
            <p className="text-xs text-muted-foreground">
              {t("mcp.admin.dashboard.sessionsStub", "Stats coming soon")}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Quick links */}
      <div>
        <Button variant="outline" asChild>
          <a href="/admin/mcp/clients">
            {t("mcp.admin.clients")}
            <ArrowRightIcon className="size-4 ml-1" />
          </a>
        </Button>
      </div>

      {/* Recent activity */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <ActivityIcon className="size-4" />
            {t("mcp.admin.dashboard.recentActivity")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {DEMO_ACTIVITY.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("mcp.admin.dashboard.noActivity")}</p>
          ) : (
            <div className="space-y-3">
              {DEMO_ACTIVITY.map((activity) => (
                <div key={activity.id} className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    <Badge
                      variant={activity.status === "success" ? "default" : "destructive"}
                      className="text-xs"
                    >
                      {activity.tool}
                    </Badge>
                    <span className="text-muted-foreground">{activity.clientName}</span>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {formatRelativeTime(activity.timestamp)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** Format a timestamp as relative time (e.g. "2m ago") */
function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "<1m ago";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default McpDashboard;
