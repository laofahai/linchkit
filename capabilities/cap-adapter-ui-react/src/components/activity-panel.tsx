/**
 * ActivityPanel — Timeline-style execution log history for a record.
 *
 * Queries execution logs filtered by schema name and displays them
 * as a vertical timeline with status badges and timestamps.
 */

import { Badge, Button } from "@linchkit/ui-kit/components";
import {
  CheckCircle,
  ChevronDown,
  ChevronUp,
  Clock,
  Loader2,
  RefreshCw,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type ExecutionLogEntry,
  queryExecutionLogs,
} from "../lib/api";

interface ActivityPanelProps {
  schemaName: string;
  recordId?: string;
}

interface StatusConfig {
  icon: typeof CheckCircle;
  color: string;
  variant: "default" | "destructive" | "outline" | "secondary";
}

const STATUS_CONFIG: Record<string, StatusConfig> = {
  succeeded: { icon: CheckCircle, color: "text-green-600 dark:text-green-400", variant: "default" },
  failed: { icon: XCircle, color: "text-red-600 dark:text-red-400", variant: "destructive" },
  blocked: { icon: ShieldAlert, color: "text-yellow-600 dark:text-yellow-400", variant: "secondary" },
  pending_approval: { icon: Clock, color: "text-blue-600 dark:text-blue-400", variant: "outline" },
};

const DEFAULT_STATUS_CONFIG: StatusConfig = {
  icon: CheckCircle,
  color: "text-muted-foreground",
  variant: "outline",
};

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function formatDuration(ms: number): string {
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function ActivityPanel({ schemaName, recordId }: ActivityPanelProps) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<ExecutionLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const result = await queryExecutionLogs({
        schema: schemaName,
        page: 1,
        pageSize: 20,
      });
      // Filter by recordId on client side if provided
      const filtered = recordId
        ? result.items.filter((e) => e.recordId === recordId)
        : result.items;
      setEntries(filtered);
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [schemaName, recordId]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  return (
    <div className="bg-background rounded shadow-sm border border-border/50 px-6 py-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-muted-foreground">
          {t("detail.activity", "Activity")}
        </h2>
        <Button variant="ghost" size="sm" onClick={fetchLogs} disabled={loading}>
          <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : entries.length === 0 ? (
        <div className="py-6 text-center text-sm text-muted-foreground">
          {t("detail.noActivity", "No activity recorded yet.")}
        </div>
      ) : (
        <div className="relative">
          {/* Timeline line */}
          <div className="absolute left-3 top-2 bottom-2 w-px bg-border" />

          <div className="space-y-0">
            {entries.map((entry) => {
              const config = STATUS_CONFIG[entry.status] ?? DEFAULT_STATUS_CONFIG;
              const StatusIcon = config.icon;
              const isExpanded = expandedId === entry.id;

              return (
                <div
                  key={entry.id}
                  className="relative pl-8 py-2 cursor-pointer hover:bg-muted/30 rounded transition-colors"
                  onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                >
                  {/* Timeline dot */}
                  <div className={`absolute left-1 top-3.5 ${config.color}`}>
                    <StatusIcon className="size-4" />
                  </div>

                  {/* Content */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium font-mono">{entry.action}</span>
                        <Badge variant={config.variant} className="text-[10px]">
                          {t(`executionLog.${entry.status === "pending_approval" ? "pendingApproval" : entry.status}`, entry.status)}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
                        <span>{entry.actor.id}</span>
                        <span className="text-border">|</span>
                        <span>{formatDuration(entry.duration)}</span>
                        {entry.stateTransition && (
                          <>
                            <span className="text-border">|</span>
                            <span>
                              {entry.stateTransition.from} → {entry.stateTransition.to}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 text-xs text-muted-foreground shrink-0">
                      <span>{formatRelativeTime(entry.startedAt)}</span>
                      {isExpanded ? (
                        <ChevronUp className="size-3" />
                      ) : (
                        <ChevronDown className="size-3" />
                      )}
                    </div>
                  </div>

                  {/* Expanded detail */}
                  {isExpanded && (
                    <div className="mt-2 p-3 bg-muted/50 rounded text-xs space-y-2">
                      <div>
                        <span className="font-medium">{t("executionLog.time", "Time")}:</span>{" "}
                        {new Date(entry.startedAt).toLocaleString()}
                      </div>
                      {entry.error && (
                        <div className="text-destructive">
                          <span className="font-medium">{t("executionLog.error", "Error")}:</span>{" "}
                          {entry.error.code && <span className="font-mono">[{entry.error.code}] </span>}
                          {entry.error.message}
                        </div>
                      )}
                      <div className="text-muted-foreground">
                        ID: {entry.id}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
