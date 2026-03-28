/**
 * ActivityPanel — Timeline-style audit trail for a record.
 *
 * Displays execution logs as a vertical timeline showing record creation,
 * field changes (old -> new), state transitions, and actor information
 * with relative timestamps.
 */

import { Badge, Button } from "@linchkit/ui-kit/components";
import {
  ArrowRight,
  ChevronDown,
  ChevronUp,
  CircleDot,
  Clock,
  Edit,
  Loader2,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  User,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { type ExecutionLogEntry, queryExecutionLogs } from "../lib/api";

interface ActivityPanelProps {
  schemaName: string;
  recordId?: string;
}

// ── Action type detection ─────────────────────────────────

type ActionKind = "create" | "update" | "delete" | "approval" | "custom";

function detectActionKind(action: string, status?: string): ActionKind {
  if (status === "pending_approval") return "approval";
  if (action.startsWith("create_")) return "create";
  if (action.startsWith("update_")) return "update";
  if (action.startsWith("delete_") || action.startsWith("soft_delete_")) return "delete";
  return "custom";
}

const ACTION_KIND_ICON = {
  create: Plus,
  update: Edit,
  delete: Trash2,
  approval: ShieldCheck,
  custom: CircleDot,
} as const;

const ACTION_KIND_COLOR = {
  create: "text-green-600 dark:text-green-400",
  update: "text-blue-600 dark:text-blue-400",
  delete: "text-red-600 dark:text-red-400",
  approval: "text-amber-600 dark:text-amber-400",
  custom: "text-purple-600 dark:text-purple-400",
} as const;

const ACTION_KIND_DOT_BG = {
  create: "bg-green-100 dark:bg-green-950 border-green-300 dark:border-green-700",
  update: "bg-blue-100 dark:bg-blue-950 border-blue-300 dark:border-blue-700",
  delete: "bg-red-100 dark:bg-red-950 border-red-300 dark:border-red-700",
  approval: "bg-amber-100 dark:bg-amber-950 border-amber-300 dark:border-amber-700",
  custom: "bg-purple-100 dark:bg-purple-950 border-purple-300 dark:border-purple-700",
} as const;

// ── Status config ──────────────────────────────────────────

interface StatusConfig {
  variant: "default" | "destructive" | "outline" | "secondary";
}

const STATUS_CONFIG: Record<string, StatusConfig> = {
  succeeded: { variant: "default" },
  failed: { variant: "destructive" },
  blocked: { variant: "secondary" },
  pending_approval: { variant: "outline" },
};

const DEFAULT_STATUS_CONFIG: StatusConfig = { variant: "outline" };

// ── Helpers ───────────────────────────────────────────────

function formatRelativeTime(
  iso: string,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return t("time.justNow", { defaultValue: "just now" });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t("time.minutesAgo", { defaultValue: "{{count}}m ago", count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("time.hoursAgo", { defaultValue: "{{count}}h ago", count: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return t("time.daysAgo", { defaultValue: "{{count}}d ago", count: days });
  return new Date(iso).toLocaleDateString();
}

function formatActionLabel(action: string, status?: string): string {
  // Strip schema prefix: "create_purchase_order" -> "create"
  // "update_purchase_order" -> "update"
  const kind = detectActionKind(action, status);
  if (kind === "approval") return "pending approval";
  if (kind !== "custom") return kind;
  // Custom actions: remove underscores, capitalize
  return action.replace(/_/g, " ");
}

/** Parse JSON-encoded input string, return field entries excluding system fields. */
function parseInputChanges(
  input: string | undefined,
  _kind: ActionKind,
): Array<{ field: string; value: unknown }> {
  if (!input) return [];
  try {
    const parsed = JSON.parse(input) as Record<string, unknown>;
    const SYSTEM_FIELDS = new Set([
      "id",
      "tenant_id",
      "created_at",
      "updated_at",
      "created_by",
      "updated_by",
      "_version",
      "is_deleted",
    ]);
    return Object.entries(parsed)
      .filter(([key]) => !SYSTEM_FIELDS.has(key))
      .map(([field, value]) => ({ field, value }));
  } catch {
    return [];
  }
}

function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

// ── Timeline Entry Component ──────────────────────────────

interface TimelineEntryProps {
  entry: ExecutionLogEntry;
  isLast: boolean;
}

function TimelineEntry({ entry, isLast }: TimelineEntryProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const kind = detectActionKind(entry.action, entry.status);
  const KindIcon = ACTION_KIND_ICON[kind];
  const kindColor = ACTION_KIND_COLOR[kind];
  const dotBg = ACTION_KIND_DOT_BG[kind];
  const statusConfig = STATUS_CONFIG[entry.status] ?? DEFAULT_STATUS_CONFIG;
  const changes = useMemo(() => parseInputChanges(entry.input, kind), [entry.input, kind]);

  return (
    <div className="relative flex gap-3 pb-4 last:pb-0">
      {/* Timeline connector line */}
      {!isLast && <div className="absolute left-[15px] top-8 bottom-0 w-px bg-border" />}

      {/* Timeline dot */}
      <div
        className={`relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border ${dotBg}`}
      >
        <KindIcon className={`size-3.5 ${kindColor}`} />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 pt-0.5">
        {/* Header row */}
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            {/* Action label + status badge */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`text-sm font-medium capitalize ${kindColor}`}>
                {t(`detail.actionKind.${kind}`, formatActionLabel(entry.action, entry.status))}
              </span>
              {entry.status !== "succeeded" && (
                <Badge variant={statusConfig.variant} className="text-[10px] px-1.5 py-0">
                  {t(
                    `executionLog.${entry.status === "pending_approval" ? "pendingApproval" : entry.status}`,
                    entry.status,
                  )}
                </Badge>
              )}
              {entry.error && (
                <Badge variant="destructive" className="text-[10px] px-1.5 py-0">
                  <XCircle className="size-2.5 mr-0.5" />
                  {t("executionLog.failed", "Failed")}
                </Badge>
              )}
            </div>

            {/* State transition */}
            {entry.stateTransition && (
              <div className="flex items-center gap-1.5 mt-1">
                <Badge
                  variant="outline"
                  className="text-[10px] px-1.5 py-0 bg-muted/50 font-normal"
                >
                  {entry.stateTransition.from}
                </Badge>
                <ArrowRight className="size-3 text-muted-foreground" />
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0 font-normal">
                  {entry.stateTransition.to}
                </Badge>
              </div>
            )}

            {/* Actor + timestamp meta */}
            <div className="flex items-center gap-1.5 mt-1 text-xs text-muted-foreground">
              <User className="size-3" />
              <span>{entry.actor.id}</span>
              <span className="text-border">·</span>
              <Clock className="size-3" />
              <span title={new Date(entry.startedAt).toLocaleString()}>
                {formatRelativeTime(entry.startedAt, t)}
              </span>
            </div>
          </div>

          {/* Expand toggle (only if there are details to show) */}
          {(changes.length > 0 || entry.error) && (
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              className="shrink-0 p-1 rounded hover:bg-muted/50 text-muted-foreground transition-colors"
            >
              {expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
            </button>
          )}
        </div>

        {/* Expanded detail: field changes */}
        {expanded && (
          <div className="mt-2 space-y-1.5">
            {/* Field changes */}
            {changes.length > 0 && (
              <div className="rounded border border-border/50 bg-muted/30 overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border/50 bg-muted/50">
                      <th className="text-left px-2.5 py-1.5 font-medium text-muted-foreground">
                        {t("detail.field", "Field")}
                      </th>
                      <th className="text-left px-2.5 py-1.5 font-medium text-muted-foreground">
                        {t("detail.value", "Value")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {changes.map((change) => (
                      <tr key={change.field} className="border-b border-border/30 last:border-0">
                        <td className="px-2.5 py-1.5 font-mono text-muted-foreground">
                          {change.field}
                        </td>
                        <td className="px-2.5 py-1.5">
                          <span className="text-foreground">{formatFieldValue(change.value)}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Error detail */}
            {entry.error && (
              <div className="rounded border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-xs text-destructive">
                <span className="font-medium">{t("executionLog.error", "Error")}:</span>{" "}
                {entry.error.code && <span className="font-mono">[{entry.error.code}] </span>}
                {entry.error.message}
              </div>
            )}

            {/* Timestamp + execution ID */}
            <div className="text-[11px] text-muted-foreground/70 px-0.5">
              {new Date(entry.startedAt).toLocaleString()} · ID: {entry.id}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main Panel Component ──────────────────────────────────

const MAX_SCROLL_HEIGHT = 480;

export function ActivityPanel({ schemaName, recordId }: ActivityPanelProps) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<ExecutionLogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const result = await queryExecutionLogs({
        schema: schemaName,
        page: 1,
        pageSize: 50,
      });
      // Filter by recordId on client side if provided
      // (server does not support recordId filter yet)
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
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-muted-foreground">
          {t("detail.activity", "Activity")}
        </h2>
        <Button variant="ghost" size="sm" onClick={fetchLogs} disabled={loading}>
          <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : entries.length === 0 ? (
        <div className="py-6 text-center text-sm text-muted-foreground">
          {t("detail.noActivity", "No activity recorded yet.")}
        </div>
      ) : (
        <div className="overflow-y-auto pr-1" style={{ maxHeight: `${MAX_SCROLL_HEIGHT}px` }}>
          {entries.map((entry, idx) => (
            <TimelineEntry key={entry.id} entry={entry} isLast={idx === entries.length - 1} />
          ))}
        </div>
      )}
    </div>
  );
}
